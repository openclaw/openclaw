import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { GATEWAY_SERVER_CAPS } from "../../packages/gateway-protocol/src/server-capabilities.js";
import { createDeferred, nextEventLoopTurn, withinTest } from "../../test/helpers/promise.js";
import { waitForFast } from "../../test/helpers/vitest-wait.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "../gateway/minimal-gateway.test-helpers.js";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import { createUpdateRunRecordFixture } from "../infra/update-run-record.test-support.js";
import { defaultRuntime } from "../runtime.js";
import * as resolveStore from "../secrets/resolve-store.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import type { TempHomeEnv } from "../test-utils/temp-home.js";
import { VERSION } from "../version.js";
import { runReleaseUpdateCli, type ReleaseUpdateOptions } from "./cli.js";
import * as installationIdentity from "./installation-identity.js";

type GatewayTestContext = {
  home: TempHomeEnv;
  root: string;
  localRun: Pick<UpdateRunRecord, "status" | "phase" | "origin">;
  useWireGateway: { enabled: boolean };
  createRun: unknown;
  prepared: unknown[];
};

export function registerReleaseUpdateGatewayTests(context: () => GatewayTestContext) {
  type WireRequest = {
    ws: WebSocket;
    id: string;
    method: string;
    params: ReturnType<typeof parseMinimalGatewayRequestFrame>["params"];
  };

  async function withWireGateway(
    options: {
      restartMethod?: "update.run" | "gateway.restart.request";
      handleRequest?: (request: WireRequest) => boolean;
      supportsConsent?: () => boolean;
    },
    run: (peer: {
      update: (options?: Partial<ReleaseUpdateOptions>) => Promise<void>;
      runId: string;
      output: UpdateRunRecord;
      requests: string[];
      receipts: Array<Pick<WireRequest, "method" | "params">>;
      tokens: Array<string | undefined>;
      json: unknown[];
      tokenReads: () => number;
      releaseCustody: () => void;
    }) => Promise<void>,
  ) {
    const restartMethod = options.restartMethod ?? "update.run";
    const { home, root, localRun, useWireGateway } = context();
    useWireGateway.enabled = true;
    vi.spyOn(installationIdentity, "checkUpdateInstallationSlot").mockResolvedValue();
    const tag = restartMethod === "gateway.restart.request" ? VERSION : undefined;
    const updateOptions = { json: true, restart: true, runningRoot: root, tag, yes: true };
    if (tag) {
      localRun.status = "running";
      localRun.phase = "activating";
    }
    const { claim, listener, releaseListener } = await reserveTestPortListener({
      offsets: [0],
      createListener: createServer,
    });
    const wss = new WebSocketServer({ server: listener });
    try {
      const configPath = path.join(home.home, "openclaw.json");
      vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
      vi.stubEnv("OPENCLAW_GATEWAY_PORT", undefined);
      const refId = "GATEWAY_TEST_TOKEN";
      const token = "wire-test-token";
      await fs.writeFile(
        configPath,
        JSON.stringify({
          gateway: {
            port: claim.port,
            auth: { mode: "token", token: { source: "store", provider: "default", id: refId } },
          },
        }),
      );
      const runId = tag ? "run-cli" : "run-wire";
      const output = createUpdateRunRecordFixture(runId, { status: "succeeded" });
      const json: unknown[] = [];
      vi.spyOn(defaultRuntime, "writeJson").mockImplementation((record) => {
        json.push(record);
      });
      const requests: string[] = [];
      const receipts: Array<Pick<WireRequest, "method" | "params">> = [];
      const tokens: Array<string | undefined> = [];
      let restartDispatched = false;
      let tokenReads = 0;
      vi.spyOn(resolveStore, "resolveStoreRefs").mockImplementation(async () => {
        tokenReads++;
        if (restartDispatched) {
          throw new Error("Restart has exclusive state custody");
        }
        return new Map([[refId, token]]);
      });
      wss.on("connection", (ws) => {
        ws.on("message", (data) => {
          const { id, method, params } = parseMinimalGatewayRequestFrame(data);
          if (!id || !method) {
            return;
          }
          if (method === "connect") {
            tokens.push(params?.auth?.token);
            const hello = buildMinimalGatewayHelloOkPayload();
            Object.assign(hello.features, {
              capabilities: options.supportsConsent?.()
                ? [GATEWAY_SERVER_CAPS.UPDATE_RUN_CONSENT_IDENTITY]
                : [],
            });
            sendMinimalGatewayResponse(ws, id, hello);
          } else {
            requests.push(method);
            receipts.push({ method, params });
            if (method === restartMethod) {
              restartDispatched = true;
            }
            if (options.handleRequest?.({ ws, id, method, params })) {
              return;
            }
            if (method === restartMethod) {
              sendMinimalGatewayResponse(ws, id, { ok: true, runId });
            } else if (method === "update.runs.get") {
              sendMinimalGatewayResponse(ws, id, { run: params?.runId === runId ? output : null });
            }
          }
        });
        sendMinimalGatewayConnectChallenge(ws);
      });

      await run({
        update: (overrides) => runReleaseUpdateCli({ ...updateOptions, ...overrides }),
        runId,
        output,
        requests,
        receipts,
        tokens,
        json,
        tokenReads: () => tokenReads,
        releaseCustody: () => {
          restartDispatched = false;
        },
      });
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
      await closeMinimalGatewayServer(wss);
      await releaseListener();
      await claim.release();
    }
  }

  it.each(["update.run", "gateway.restart.request"] as const)(
    "follows %s without reading the Gateway token store after restart dispatch",
    async (restartMethod) => {
      await withWireGateway({ restartMethod }, async (peer) => {
        await peer.update();
        expect(peer.requests).toEqual([restartMethod, "update.runs.get"]);
        expect(peer.receipts[0]?.params).not.toHaveProperty("timeoutMs");
        expect(peer.tokens).toEqual(["wire-test-token", "wire-test-token"]);
        expect(peer.tokenReads()).toBe(1);
        expect(peer.json).toEqual([peer.output]);
        expect(process.exitCode).toBe(0);
      });
    },
  );

  it.for(["acknowledgement", "status", "poll delay"] as const)(
    "keeps the overall Gateway update budget during %s",
    async (scenario, { signal }) => {
      const heldClosed = createDeferred();
      let held: WireRequest | undefined;
      let statusRequests = 0;
      let running: UpdateRunRecord;
      await withWireGateway(
        {
          handleRequest: (request) => {
            if (request.method === "update.runs.get") {
              statusRequests++;
              if (scenario === "status" && statusRequests === 1) {
                sendMinimalGatewayResponse(request.ws, request.id, { run: running });
                return true;
              }
            }
            if (
              (scenario === "acknowledgement" && request.method === "update.run") ||
              (scenario !== "acknowledgement" && request.method === "update.runs.get")
            ) {
              held = request;
              request.ws.once("close", () => heldClosed.resolve());
              return true;
            }
            return false;
          },
        },
        async (peer) => {
          running = { ...peer.output, status: "running", phase: "staging", finishedAtMs: null };
          vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
          const deadline = Date.now() + 5_000;
          const settled = Promise.allSettled([peer.update({ timeoutMs: 5_000 })]);
          try {
            // Only an actual wire receipt proves that the held request was dispatched.
            await waitForFast(
              () => expect(held, "Gateway received the held request").toBeDefined(),
              { timeout: deadline - Date.now() },
            );
            const request = held!;
            if (scenario === "poll delay") {
              await vi.advanceTimersByTimeAsync(Math.max(0, deadline - Date.now() - 1_000));
              // A bare promise would hide registration until the sleep itself finishes.
              const registered = createDeferred<{ wait: Promise<unknown> }>();
              // Named promise timers can stay real on Node/Bun; control this poll's wait only.
              vi.mocked(sleep).mockImplementationOnce((delay, value) => {
                const wait = new Promise((resolve) => {
                  globalThis.setTimeout(resolve, delay, value);
                });
                registered.resolve({ wait });
                return wait;
              });
              sendMinimalGatewayResponse(request.ws, request.id, { run: running });
              await withinTest(heldClosed.promise, signal);
              await nextEventLoopTurn();
              await vi.advanceTimersByTimeAsync(0);
              const { wait } = await withinTest(registered.promise, signal);
              await vi.advanceTimersByTimeAsync(Math.max(0, deadline - Date.now()));
              expect(
                await Promise.race([wait, Promise.resolve("pending")]),
                "polling wait settled at the update deadline",
              ).toBeUndefined();
            }
            await vi.advanceTimersByTimeAsync(Math.max(0, deadline - Date.now()));
            // Freeze expiry while RPC cleanup joins; a longer timer must remain pending.
            const [outcome] = await withinTest(settled, signal);
            const error = outcome.status === "rejected" ? outcome.reason : undefined;
            await withinTest(heldClosed.promise, signal);
            if (scenario === "acknowledgement") {
              expect(error).toBeInstanceOf(Error);
              expect(String(error)).toMatch(/did not finish|timeout/i);
            } else {
              expect(outcome).toEqual({ status: "fulfilled", value: undefined });
              expect(peer.json).toEqual([running]);
              expect(process.exitCode).toBe(1);
            }
            expect(peer.requests).toEqual([
              "update.run",
              ...(scenario === "acknowledgement" ? [] : ["update.runs.get"]),
              ...(scenario === "status" ? ["update.runs.get"] : []),
            ]);
            expect(peer.tokenReads()).toBe(1);
            expect(context().createRun).not.toHaveBeenCalled();
            expect(context().prepared).toEqual([]);
          } finally {
            // Release the peer even when the pre-fix client is still waiting, then
            // join its command before the fixture closes sockets or restores the clock.
            if (held?.ws.readyState === WebSocket.OPEN) {
              sendMinimalGatewayResponse(
                held.ws,
                held.id,
                held.method === "update.run"
                  ? { ok: true, runId: peer.runId }
                  : { run: peer.output },
              );
            }
            await vi.advanceTimersByTimeAsync(30_000);
            await settled;
            vi.mocked(sleep).mockReset();
          }
        },
      );
    },
  );

  it.for(["remaining", "expired"] as const)(
    "keeps the original deadline when capability consent has %s budget",
    async (scenario, { signal }) => {
      let updates = 0;
      let status: WireRequest | undefined;
      let retry: WireRequest | undefined;
      const statusClosed = createDeferred();
      await withWireGateway(
        {
          supportsConsent: () => updates > 0,
          handleRequest: (request) => {
            if (request.method === "update.run" && ++updates === 2) {
              retry = request;
              return true;
            }
            if (request.method === "update.runs.get") {
              status = request;
              request.ws.once("close", () => statusClosed.resolve());
              return true;
            }
            return false;
          },
        },
        async (peer) => {
          peer.output.origin.nextAction = "Run `openclaw update --accept-capabilities`.";
          vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
          const deadline = Date.now() + 5_000;
          vi.spyOn(defaultRuntime, "log").mockImplementation((line) => {
            // The first run is confirmed. Expiry while reporting it must not
            // admit a second mutation or hide consent behind the first success.
            if (scenario === "expired" && line === "finished: finished") {
              vi.setSystemTime(deadline);
            }
          });
          const settled = Promise.allSettled([
            peer.update({ json: false, acceptCapabilities: true, timeoutMs: 5_000 }),
          ]);
          try {
            await waitForFast(() => expect(status).toBeDefined());
            await vi.advanceTimersByTimeAsync(Math.max(0, deadline - Date.now() - 2_500));
            // The completed first run has released its exclusive auth custody;
            // only the replacement connection may resolve credentials again.
            peer.releaseCustody();
            sendMinimalGatewayResponse(status!.ws, status!.id, { run: peer.output });
            await withinTest(statusClosed.promise, signal);
            if (scenario === "remaining") {
              await waitForFast(() => expect(retry).toBeDefined());
              expect(retry?.params).toEqual(
                expect.objectContaining({
                  acceptCapabilities: true,
                  timeoutMs: expect.any(Number),
                }),
              );
              expect(retry?.params?.timeoutMs).toBeGreaterThan(0);
              expect(retry?.params?.timeoutMs).toBeLessThanOrEqual(2_500);
              await vi.advanceTimersByTimeAsync(Math.max(0, deadline - Date.now()));
            }
            const [outcome] = await withinTest(settled, signal);
            const error = outcome.status === "rejected" ? outcome.reason : undefined;
            expect(String(error)).toContain("Capability consent could not be confirmed");
            expect(String(error)).toContain("openclaw update status` before retrying");
            expect(peer.requests).toEqual([
              "update.run",
              "update.runs.get",
              ...(scenario === "remaining" ? ["update.run"] : []),
            ]);
            expect(peer.tokenReads()).toBe(scenario === "remaining" ? 2 : 1);
            expect(context().createRun).not.toHaveBeenCalled();
            expect(context().prepared).toEqual([]);
          } finally {
            if (status?.ws.readyState === WebSocket.OPEN) {
              sendMinimalGatewayResponse(status.ws, status.id, { run: peer.output });
            }
            if (retry?.ws.readyState === WebSocket.OPEN) {
              sendMinimalGatewayResponse(retry.ws, retry.id, { ok: true, runId: peer.runId });
            }
            await vi.advanceTimersByTimeAsync(30_000);
            await settled;
          }
        },
      );
    },
  );
}
