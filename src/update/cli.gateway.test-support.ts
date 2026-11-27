import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { GATEWAY_SERVER_CAPS } from "../../packages/gateway-protocol/src/server-capabilities.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  nextEventLoopTurn,
  withinTest,
} from "../../test/helpers/promise.js";
import { waitForFast } from "../../test/helpers/vitest-wait.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "../gateway/minimal-gateway.test-helpers.js";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import { defaultRuntime } from "../runtime.js";
import * as resolveStore from "../secrets/resolve-store.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import type { TempHomeEnv } from "../test-utils/temp-home.js";
import { VERSION } from "../version.js";
import { runReleaseUpdateCli } from "./cli.js";
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

  type WireRun = Pick<UpdateRunRecord, "runId" | "status" | "phase" | "steps" | "after" | "origin">;

  async function withWireGateway(
    options: {
      restartMethod?: "update.run" | "gateway.restart.request";
      handleRequest?: (request: WireRequest) => boolean;
      supportsConsent?: () => boolean;
    },
    run: (peer: {
      root: string;
      tag: string | undefined;
      runId: string;
      output: WireRun;
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
      const output: WireRun = {
        runId,
        status: "succeeded",
        phase: "finished",
        steps: [],
        after: {},
        origin: {},
      };
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
            sendMinimalGatewayResponse(ws, id, {
              ...hello,
              features: {
                ...hello.features,
                capabilities: options.supportsConsent?.()
                  ? [GATEWAY_SERVER_CAPS.UPDATE_RUN_CONSENT_IDENTITY]
                  : [],
              },
            });
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
        root,
        tag,
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
        await runReleaseUpdateCli({
          json: true,
          restart: true,
          runningRoot: peer.root,
          tag: peer.tag,
          yes: true,
        });
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
      const heldRequest = createDeferred<WireRequest>();
      const heldClosed = createDeferred();
      const firstStatusClosed = createDeferred();
      let held: WireRequest | undefined;
      let statusRequests = 0;
      let running: WireRun;
      await withWireGateway(
        {
          handleRequest: (request) => {
            if (request.method === "update.runs.get") {
              statusRequests++;
              if (scenario === "status" && statusRequests === 1) {
                request.ws.once("close", () => firstStatusClosed.resolve());
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
              heldRequest.resolve(request);
              return true;
            }
            return false;
          },
        },
        async (peer) => {
          running = { ...peer.output, status: "running", phase: "staging" };
          vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
          const deadline = Date.now() + 5_000;
          let outcome: { error?: unknown } | undefined;
          const command = runReleaseUpdateCli({
            json: true,
            restart: true,
            runningRoot: peer.root,
            yes: true,
            timeoutMs: 5_000,
          });
          const settled = command.then(
            () => {
              outcome = {};
            },
            (error: unknown) => {
              outcome = { error };
            },
          );
          try {
            // Readiness owns timers before opening the real socket. Drive those
            // without consuming the budget we reserve for the withheld response.
            await waitForFast(() => expect(peer.requests).toContain("update.run"));
            if (scenario === "status") {
              await waitForFast(() => expect(peer.requests).toContain("update.runs.get"));
              await withinTest(
                awaitGateBeforeSettlement(
                  firstStatusClosed.promise,
                  command,
                  "command settled before observing the running update",
                ),
                signal,
              );
              await nextEventLoopTurn();
              await vi.advanceTimersByTimeAsync(0);
              await vi.advanceTimersByTimeAsync(2_000);
            }
            await waitForFast(() =>
              expect(held, "Gateway received the held request").toBeDefined(),
            );
            const request = await withinTest(
              awaitGateBeforeSettlement(
                heldRequest.promise,
                command,
                "command settled before the Gateway received its request",
              ),
              signal,
            );
            if (scenario === "poll delay") {
              await vi.advanceTimersByTimeAsync(Math.max(0, deadline - Date.now() - 1_000));
              sendMinimalGatewayResponse(request.ws, request.id, { run: running });
              await withinTest(heldClosed.promise, signal);
              await nextEventLoopTurn();
              await vi.advanceTimersByTimeAsync(0);
            }
            await vi.advanceTimersByTimeAsync(Math.max(0, deadline - Date.now()));
            await waitForFast(
              () => expect(outcome, "CLI settled by the original deadline").toBeDefined(),
              { timeout: 100 },
            );
            await settled;
            if (scenario === "acknowledgement") {
              expect(outcome?.error).toBeInstanceOf(Error);
              expect(String(outcome?.error)).toMatch(/did not finish|timeout/i);
              await withinTest(heldClosed.promise, signal);
            } else {
              expect(outcome).toEqual({});
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
            vi.useRealTimers();
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
          vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
          const deadline = Date.now() + 5_000;
          vi.spyOn(defaultRuntime, "log").mockImplementation((line) => {
            // The first run is confirmed. Expiry while reporting it must not
            // admit a second mutation or hide consent behind the first success.
            if (scenario === "expired" && line === "finished: finished") {
              vi.setSystemTime(deadline);
            }
          });
          let outcome: { error?: unknown } | undefined;
          const command = runReleaseUpdateCli({
            json: false,
            restart: true,
            runningRoot: peer.root,
            yes: true,
            acceptCapabilities: true,
            timeoutMs: 5_000,
          });
          const settled = command.then(
            () => {
              outcome = {};
            },
            (error: unknown) => {
              outcome = { error };
            },
          );
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
            await waitForFast(() => expect(outcome).toBeDefined(), { timeout: 100 });
            await settled;
            expect(String(outcome?.error)).toContain("Capability consent could not be confirmed");
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
            vi.useRealTimers();
          }
        },
      );
    },
  );
}
