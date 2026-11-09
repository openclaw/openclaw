import { stripVTControlCharacters } from "node:util";
import { expect, it, vi } from "vitest";
import { WebSocket } from "../../packages/gateway-client/src/websocket.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { setVerbose } from "../global-state.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import type { Deferred } from "../shared/deferred.js";
import { createStartupTestState } from "./server-startup.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { setGatewayWsLogStyle } from "./ws-logging.js";

const pluginId = "session-action-attribution-proof";
const longActionId = "a".repeat(239) + "🦊overlength-suffix";
const privateValue = "private-action-content";
function expectRequestId(line: string, requestId: string) {
  expect(requestId).not.toBe("");
  const loggedId = line.match(/(?:^|\s)id=(\S+)/)?.[1] ?? "";
  if (loggedId === requestId) {
    return;
  }
  expect(loggedId.length).toBeLessThanOrEqual(24);
  const parts = loggedId.split("…");
  expect(parts).toHaveLength(2);
  const [prefix = "", suffix = ""] = parts;
  expect(prefix.length).toBeGreaterThanOrEqual(4);
  expect(suffix.length).toBeGreaterThanOrEqual(4);
  expect(prefix.length + suffix.length).toBeGreaterThanOrEqual(12);
  expect(prefix.length + suffix.length).toBeLessThan(requestId.length);
  expect(requestId.startsWith(prefix)).toBe(true);
  expect(requestId.endsWith(suffix)).toBe(true);
}
type Gate = { entered: Deferred; release: Deferred };
const globals = globalThis as typeof globalThis & { sessionActionAttributionGate?: Gate };
const source = `module.exports = { id: "${pluginId}", register(api) {
  for (const id of ["success", "application-error", "dispatch-error", ${JSON.stringify(longActionId)}]) {
    api.session.controls.registerSessionAction({ id, requiredScopes: ["operator.read"],
      async handler({ payload }) {
        const gate = globalThis.sessionActionAttributionGate;
        gate.entered.resolve();
        await gate.release.promise;
        if (id === "dispatch-error") throw new Error(payload.privateValue);
        return id === "application-error"
          ? { ok: false, error: payload.privateValue, code: "PRIVATE_CODE", details: payload }
          : { result: payload, reply: payload, continueAgent: true };
      },
    });
  }
} };`;

it("keeps registered session-action attribution in WS diagnostics outside authenticated responses", async ({
  signal,
}) => {
  await using state = await createStartupTestState("session-action-attribution", {
    OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  });
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
  let acquisition: ReturnType<typeof startGatewayWithClient> | undefined;
  let reportedAcquisitionError: unknown;
  const previousConsole = loggingState.rawConsole;
  const previousGate = globals.sessionActionAttributionGate;
  const output = vi.fn();
  await runQaGatewayFixture(
    async () => {
      const pluginDir = state.statePath("plugin");
      await state.writeJson("plugin/package.json", {
        name: pluginId,
        version: "1.0.0",
        openclaw: { extensions: ["./index.cjs"] },
      });
      await state.writeJson("plugin/openclaw.plugin.json", {
        id: pluginId,
        activation: { onStartup: true },
        configSchema: { type: "object" },
      });
      await state.writeText("plugin/index.cjs", source);
      const token = "session-action-attribution-token";
      acquisition = startGatewayWithClient({
        configPath: state.configPath,
        token,
        scopes: ["operator.admin", "operator.read", "operator.write"],
        cfg: {
          agents: {
            defaults: { workspace: state.workspaceDir, skipBootstrap: true },
            entries: { main: {} },
          },
          gateway: { auth: { mode: "token", token } },
          plugins: { allow: [pluginId], load: { paths: [pluginDir] }, slots: { memory: "none" } },
        },
      }).then((started) => {
        gateway = started;
        return started;
      });
      try {
        gateway = await withinTest(acquisition, signal);
      } catch (error) {
        reportedAcquisitionError = error;
        throw error;
      }
      await withinTest(gateway.server.startupSettled, signal);
      setVerbose(true);
      setGatewayWsLogStyle("full");
      setLoggerOverride({ level: "silent", consoleLevel: "info" });
      loggingState.rawConsole = { log: output, info: output, warn: output, error: output };
      // Observe decoded network frames; the native send path can bypass ws.send.
      const messages = vi.spyOn(WebSocket.prototype, "emit");
      const responseLines = () =>
        output.mock.calls
          .flatMap((args) => args.filter((value): value is string => typeof value === "string"))
          .map(stripVTControlCharacters)
          .filter((line) => line.includes("res") && line.includes("plugins.sessionAction"));
      const frames = (id: string) =>
        messages.mock.calls.flatMap((args: unknown[]) => {
          const [event, data] = args;
          if (event !== "message" || (typeof data !== "string" && !Buffer.isBuffer(data))) {
            return [];
          }
          const frame = JSON.parse(data.toString()) as Record<string, unknown>;
          return frame.type === "res" && frame.id === id ? [frame] : [];
        });

      for (const actionId of ["success", "application-error", "dispatch-error", longActionId]) {
        output.mockClear();
        messages.mockClear();
        const gate = { entered: createDeferred(), release: createDeferred() };
        globals.sessionActionAttributionGate = gate;
        let requestId = "";
        const response = gateway.client
          .request(
            "plugins.sessionAction",
            {
              pluginId,
              actionId,
              payload: { privateValue },
            },
            {
              onSent: (id) => {
                requestId = id;
              },
            },
          )
          .then(
            (payload) => ({ ok: true as const, payload }),
            (error: unknown) => ({ ok: false as const, error }),
          );
        try {
          await withinTest(
            awaitGateBeforeSettlement(
              gate.entered.promise,
              response,
              "Action settled before its fixture gate",
            ),
            signal,
          );
          expect(responseLines()).toEqual([]);
        } finally {
          gate.release.resolve();
        }
        const result = await response;
        const expectedPayload =
          actionId === "application-error"
            ? { ok: false, error: privateValue, code: "PRIVATE_CODE", details: { privateValue } }
            : { ok: true, result: { privateValue }, reply: { privateValue }, continueAgent: true };
        if (actionId === "dispatch-error") {
          expect(result).toMatchObject({
            ok: false,
            error: { code: "UNAVAILABLE", message: "plugin session action failed" },
          });
          expect(frames(requestId)).toEqual([
            {
              type: "res",
              id: requestId,
              ok: false,
              error: { code: "UNAVAILABLE", message: "plugin session action failed" },
            },
          ]);
        } else {
          expect(result).toEqual({ ok: true, payload: expectedPayload });
          expect(frames(requestId)).toEqual([
            { type: "res", id: requestId, ok: true, payload: expectedPayload },
          ]);
        }
        const lines = responseLines();
        expect(lines).toHaveLength(1);
        expectRequestId(lines[0]!, requestId);
        expect(lines[0]).toContain(`pluginId=${pluginId}`);
        expect(lines[0]).toContain(
          `actionId=${actionId === longActionId ? "a".repeat(239) : actionId} `,
        );
        expect(lines[0]).toContain(
          `actionOutcome=${actionId === longActionId ? "success" : actionId}`,
        );
        expect(lines[0]).toMatch(/handlerMs=\d+\b/);
        expect(lines[0]).toContain("reloadWaitMs=0");
        expect(lines[0]).not.toContain(privateValue);
        expect(lines[0]).not.toContain("PRIVATE_CODE");
        expect(lines[0]).not.toContain("🦊");
        expect(lines[0]).not.toContain("overlength-suffix");
      }

      output.mockClear();
      messages.mockClear();
      let unknownRequestId = "";
      await expect(
        gateway.client.request(
          "plugins.sessionAction",
          {
            pluginId,
            actionId: "missing",
            payload: { privateValue },
          },
          {
            onSent: (id) => {
              unknownRequestId = id;
            },
          },
        ),
      ).rejects.toMatchObject({ code: "UNAVAILABLE" });
      expect(frames(unknownRequestId)).toEqual([
        {
          type: "res",
          id: unknownRequestId,
          ok: false,
          error: {
            code: "UNAVAILABLE",
            message: `unknown plugin session action: ${pluginId}/missing`,
          },
        },
      ]);
      expect(responseLines()).toHaveLength(1);
      expectRequestId(responseLines()[0]!, unknownRequestId);
      expect(responseLines()[0]).not.toMatch(
        /pluginId=|actionId=|actionOutcome=|handlerMs=|reloadWaitMs=/,
      );
      expect(responseLines()[0]).not.toContain(privateValue);
    },
    async () => {
      // A timed-out startup still owns late success or failure until acquisition settles.
      try {
        await acquisition;
      } catch (error) {
        if (error !== reportedAcquisitionError) {
          throw error;
        }
      }
    },
    () => globals.sessionActionAttributionGate?.release.resolve(),
    () => gateway && disconnectGatewayClient(gateway.client),
    () => gateway?.server.close({ reason: "session action attribution proof complete" }),
    () => {
      if (previousGate) {
        globals.sessionActionAttributionGate = previousGate;
      } else {
        delete globals.sessionActionAttributionGate;
      }
      loggingState.rawConsole = previousConsole;
      setVerbose(false);
      setGatewayWsLogStyle("auto");
      setLoggerOverride(null);
      resetLogger();
      vi.restoreAllMocks();
    },
  );
}, 120_000);
