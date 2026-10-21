import { randomBytes } from "node:crypto";
import type { Worker } from "node:worker_threads";
import { afterEach, expect, test, vi } from "vitest";
import { loadSessionEntry, loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { loadOrCreateProcessDeviceIdentityAsync } from "../infra/device-identity-async.js";
import { createGatewayActiveWorkSnapshot } from "../infra/gateway-active-work.js";
import * as sessionLifecycle from "../sessions/session-controller.lifecycle.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import { initializeSessionReadContext } from "./server-methods/sessions-read-cache.test-support.js";
import type { GatewayClient, RespondFn } from "./server-methods/types.js";
import {
  chatSendOwner,
  setupSessionCreateHandlerTestHarness,
} from "./server.sessions.create.test-support.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

const fault = vi.hoisted(() => ({
  state: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2),
}));

// Fail a real SQLite statement at either startup boundary, without filling the host disk.
vi.mock("../infra/worker-cpu.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/worker-cpu.js")>();
  const preload = `
    import { DatabaseSync } from "node:sqlite";
    import { workerData } from "node:worker_threads";
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function(sql) {
      const statement = prepare.call(this, sql);
      const transcript = /insert into "?transcript_events/i.test(sql);
      const placement = /from "?worker_session_placements/i.test(sql);
      if (transcript || placement) {
        // Kysely reads use all() on newer Node and iterate() on Bun/older Node.
        for (const method of ["run", "all", "get", "iterate"]) {
          const run = statement[method].bind(statement);
          statement[method] = (...args) => {
            const state = new Int32Array(workerData.diskFullState);
            const mode = Atomics.load(state, 0);
            if ((mode === 1 && transcript) || (mode === 2 && placement)) {
              if (transcript) Atomics.store(state, 0, 0);
              try {
                if (placement) {
                  // Warm placement reads reuse their lease. Exhaust this worker's
                  // temporary pager to fail the same admission read deterministically.
                  this.exec("CREATE TEMP TABLE disk_full_probe(value); PRAGMA temp.max_page_count=2; INSERT INTO disk_full_probe VALUES(zeroblob(65536))");
                }
                const pages = prepare.call(this, "PRAGMA page_count").get().page_count;
                this.exec("PRAGMA max_page_count=" + pages);
                return run(...args);
              } catch (error) {
                if (error.errcode === 13) Atomics.add(state, 1, 1);
                throw error;
              } finally {
                this.exec("PRAGMA max_page_count=4294967294; PRAGMA temp.max_page_count=4294967294; DROP TABLE IF EXISTS temp.disk_full_probe");
              }
            }
            return run(...args);
          };
        }
      }
      return statement;
    };
  `;
  return {
    ...actual,
    createCpuTrackedWorker(
      filename: string | URL,
      options: ConstructorParameters<typeof Worker>[1],
    ) {
      return actual.createCpuTrackedWorker(filename, {
        ...options,
        execArgv: [
          ...(options?.execArgv ?? []),
          "--import",
          `data:text/javascript,${encodeURIComponent(preload)}`,
        ],
        workerData: { ...options?.workerData, diskFullState: fault.state },
      });
    },
  };
});

const { createSessionStoreDir } = setupSessionCreateHandlerTestHarness();
const diskState = new Int32Array(fault.state);
const diskFullMessage = "OpenClaw couldn't save your conversation because the disk is full";
afterEach(() => Atomics.store(diskState, 0, 0));

test.each(["transcript", "admission"] as const)(
  "sessions.create reports an initial %s failure after creating the session",
  async (phase) => {
    const { storePath } = await createSessionStoreDir();
    await loadOrCreateProcessDeviceIdentityAsync();
    const placements = createWorkerSessionPlacementStore();
    const context = createDirectChatContext({ workerSessionPlacementService: placements });
    context.readPreparedGatewayModelCatalog = async () => {
      const catalog = await context.loadGatewayModelCatalogSnapshot();
      return { entries: catalog.entries, routeVariants: catalog.routeVariants };
    };
    await initializeSessionReadContext(context);
    const client: GatewayClient = {
      connId: "disk-full-browser",
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        role: "operator",
        scopes: ["operator.read", "operator.write", "operator.admin"],
        client: { id: "openclaw-control-ui", version: "test", platform: "web", mode: "webchat" },
      },
    };
    const key = "agent:main:dashboard:disk-full";
    Atomics.store(diskState, 1, 0);
    let startingTurn = false;
    const admissionFailures: string[] = [];
    const begin = sessionLifecycle.beginSessionEffect;
    using admissionSpy = vi
      .spyOn(sessionLifecycle, "beginSessionEffect")
      .mockImplementation((params) => {
        if (phase !== "admission" || !startingTurn || !params.sourceInput) {
          return begin(params);
        }
        return begin({
          ...params,
          revalidateAllowed: async () => {
            Atomics.store(diskState, 0, 2);
            // Exercise real worker failure inside mandatory startup, independent of warm caches.
            try {
              await placements.getWithMoveAsync("disk-full-admission");
            } catch (error) {
              admissionFailures.push(String(error));
              throw error;
            }
            await params.revalidateAllowed?.();
          },
        });
      });
    const send = chatSendOwner.handleDirectExternalChatSend;
    using sendSpy = vi
      .spyOn(chatSendOwner, "handleDirectExternalChatSend")
      .mockImplementation(async (...args) => {
        startingTurn = true;
        if (phase === "transcript") {
          Atomics.store(diskState, 0, 1);
        }
        return send(...args);
      });
    type Created = {
      key: string;
      sessionId: string;
      runStarted: boolean;
      runError?: { message: string };
    };
    const params = {
      agentId: "main",
      key,
      message:
        "disk-full-initial-turn " +
        (phase === "transcript" ? randomBytes(65536).toString("hex") : "start"),
    };
    const respond = vi.fn<RespondFn>();
    await handleGatewayRequest({
      req: { type: "req", id: "create-disk-full", method: "sessions.create", params },
      client,
      context,
      respond,
      isWebchatConnect: () => true,
    });
    Atomics.store(diskState, 0, 0);
    expect(respond).toHaveBeenCalledOnce();
    const [ok, payload, error] = respond.mock.calls[0]!;
    const created = { ok, payload: payload as Created | undefined, error };
    expect(sendSpy).toHaveBeenCalledOnce();
    expect(admissionSpy).toHaveBeenCalled();
    expect(Atomics.load(diskState, 1), JSON.stringify(created)).toBeGreaterThan(0);
    expect(created, JSON.stringify({ created, admissionFailures })).toMatchObject({
      ok: true,
      payload: { key, runStarted: false },
    });
    expect(created.payload).not.toHaveProperty("messageSeq");
    if (phase === "admission") {
      expect(created.payload?.runError).toMatchObject({ retryable: true });
    }
    const scope = {
      agentId: "main",
      sessionKey: key,
      sessionId: created.payload!.sessionId,
      storePath,
    };
    expect(await loadTranscriptEvents(scope)).not.toContainEqual(
      expect.objectContaining({ message: expect.objectContaining({ role: "user" }) }),
    );
    expect(loadSessionEntry(scope)).toMatchObject({ sessionId: scope.sessionId });
    expect(loadSessionEntry(scope)?.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(createGatewayActiveWorkSnapshot().counts.totalActive).toBe(0);
    expect(context.broadcast, JSON.stringify({ created, admissionFailures })).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({
        sessionKey: key,
        state: "error",
        errorMessage: expect.stringContaining(diskFullMessage),
      }),
      expect.anything(),
    );
    expect(created.payload?.runError?.message).toContain(diskFullMessage);
  },
);
