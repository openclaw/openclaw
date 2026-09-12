// Real configured RPC/HTTP verification around a supplied native join receipt.
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  buildMinimalGatewayHelloOkPayload,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "../gateway/minimal-gateway.test-helpers.js";
import { triageAfterFailure } from "./triage-failure.js";
const mocks = vi.hoisted(() => ({ join: vi.fn() }));
vi.mock("../infra/triage-continuation.js", () => ({
  continueTriageInFreshProcess: mocks.join,
  queueManagedUpdateTriage: async () => false,
  resolveTriageEntrypoint: async () => [process.execPath, "unused-fixture-entry", "triage"],
}));
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

it.each([
  "verified",
  "no-effect",
  "forged-success",
  "wrong-owner",
  "wrong-root",
  "wrong-request",
  "replaced-boot",
])(
  "checks original startup %s after native join without changing original output",
  async (mode) => {
    const root = await fs.realpath(dirs.make("startup-parent-"));
    let healthy = false;
    let boot = "repair-boot";
    const server = createServer((_request, response) => {
      response.statusCode = healthy ? 200 : 503;
      response.end();
    });
    const sockets = new WebSocketServer({ server });
    sockets.on("connection", (socket) => {
      sendMinimalGatewayConnectChallenge(socket);
      socket.on("message", (data) => {
        const request = parseMinimalGatewayRequestFrame(data);
        if (request.type !== "req" || !request.id) {
          return;
        }
        if (request.method === "connect") {
          const hello = buildMinimalGatewayHelloOkPayload({
            auth: { role: "operator", scopes: ["operator.read"] },
          });
          sendMinimalGatewayResponse(socket, request.id, {
            ...hello,
            server: {
              ...hello.server,
              version: "2026.9.11",
              bootId: boot,
              buildId: "requested-build",
            },
          });
        } else {
          sendMinimalGatewayResponse(socket, request.id, { ok: true });
        }
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("fixture address unavailable");
    }
    for (const [key, value] of Object.entries({
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      OPENCLAW_GATEWAY_PORT: String(address.port),
      OPENCLAW_SHELL: "",
      CODEX_THREAD_ID: "",
      OPENCLAW_SUPERVISOR_MODE: "",
      OPENCLAW_SERVICE_MARKER: "",
      OPENCLAW_UPDATE_RUN_HANDOFF: "",
    })) {
      vi.stubEnv(key, value);
    }
    await fs.writeFile(
      path.join(root, "openclaw.json"),
      JSON.stringify({ gateway: { port: address.port, auth: { mode: "none" } } }),
    );
    const failure = {
      kind: "gateway-startup" as const,
      phase: "startup",
      error: "original listener failure",
      gateway: "verify-running" as const,
      installationRoot: root,
      expectedVersion: "2026.9.11",
    };
    mocks.join.mockImplementation(async () => {
      healthy = mode !== "no-effect" && mode !== "forged-success";
      if (mode === "replaced-boot") {
        boot = "replacement-boot";
      }
      const report = {
        kind: "startup-repair",
        installationRoot: mode === "wrong-root" ? root + "-other" : root,
        generationOwner: mode === "wrong-owner" ? "other-owner" : "joined-owner",
        failure: {
          kind: failure.kind,
          phase: failure.phase,
          gateway: failure.gateway,
          expectedVersion: mode === "wrong-request" ? "restored-old" : failure.expectedVersion,
        },
        attempted: true,
        agentExitCode: 0,
        before: { ok: false, port: address.port, summary: "startup-unhealthy" },
        after: {
          ok: mode !== "no-effect",
          port: address.port,
          version: "2026.9.11",
          bootId: "repair-boot",
          summary: mode === "no-effect" ? "startup-unhealthy" : "startup-verified",
        },
      };
      return {
        status: "completed",
        installationRoot: root,
        generationOwner: "joined-owner",
        commandOutput: { kind: "complete", stdout: JSON.stringify(report) },
      };
    });
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    try {
      const result = await triageAfterFailure(runtime, failure);
      if (mode === "verified" || mode === "no-effect") {
        expect(result).toMatchObject({
          kind: "startup-repair",
          attempted: true,
          after: { ok: mode === "verified" },
        });
      } else {
        expect(result).toBeUndefined();
      }
      expect(runtime.log).not.toHaveBeenCalled();
      expect(runtime.exit).not.toHaveBeenCalled();
      expect(mocks.join).toHaveBeenCalledOnce();
      expect(failure.error).toBe("original listener failure");
    } finally {
      mocks.join.mockClear();
      for (const client of sockets.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => {
        sockets.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  },
);
