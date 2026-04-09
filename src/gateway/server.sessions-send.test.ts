import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, type Mock } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionTranscriptPath } from "../config/sessions.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { captureEnv } from "../test-utils/env.js";
import {
  agentCommand,
  getFreePort,
  installGatewayTestHooks,
  startGatewayServer,
  testState,
} from "./test-helpers.js";

const { __testing: openClawToolsTesting, createOpenClawTools } =
  await import("../agents/openclaw-tools.js");
const { callGateway } = await import("./call.js");
const { loadConfig } = await import("../config/config.js");

installGatewayTestHooks({ scope: "suite" });

let server: Awaited<ReturnType<typeof startGatewayServer>>;
let gatewayPort: number;
let envSnapshot: ReturnType<typeof captureEnv>;

type SessionSendTool = ReturnType<typeof createOpenClawTools>[number];
const SESSION_SEND_E2E_TIMEOUT_MS = 10_000;

function getGatewayToken(): string {
  const token = (testState.gatewayAuth as { token?: unknown } | undefined)?.token;
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("gateway test token missing");
  }
  return token;
}

function getSessionsSendTool(): SessionSendTool {
  const tool = createOpenClawTools({
    config: loadConfig(),
  }).find((candidate) => candidate.name === "sessions_send");
  if (!tool) {
    throw new Error("missing sessions_send tool");
  }
  return tool;
}

async function emitLifecycleAssistantReply(params: {
  opts: unknown;
  defaultSessionId: string;
  includeTimestamp?: boolean;
  resolveText: (extraSystemPrompt?: string) => string;
}) {
  const commandParams = params.opts as {
    sessionId?: string;
    runId?: string;
    extraSystemPrompt?: string;
  };
  const sessionId = commandParams.sessionId ?? params.defaultSessionId;
  const runId = commandParams.runId ?? sessionId;
  const sessionFile = resolveSessionTranscriptPath(sessionId);
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });

  const startedAt = Date.now();
  emitAgentEvent({
    runId,
    stream: "lifecycle",
    data: { phase: "start", startedAt },
  });

  const text = params.resolveText(commandParams.extraSystemPrompt);
  const message = {
    role: "assistant",
    content: [{ type: "text", text }],
    ...(params.includeTimestamp ? { timestamp: Date.now() } : {}),
  };
  await fs.appendFile(sessionFile, `${JSON.stringify({ message })}\n`, "utf8");

  emitAgentEvent({
    runId,
    stream: "lifecycle",
    data: { phase: "end", startedAt, endedAt: Date.now() },
  });
}

beforeAll(async () => {
  envSnapshot = captureEnv(["OPENCLAW_GATEWAY_PORT", "OPENCLAW_GATEWAY_TOKEN"]);
  gatewayPort = await getFreePort();
  process.env.OPENCLAW_GATEWAY_PORT = String(gatewayPort);
  const { approveDevicePairing, requestDevicePairing } = await import("../infra/device-pairing.js");
  const { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem } =
    await import("../infra/device-identity.js");
  const identity = loadOrCreateDeviceIdentity();
  const pending = await requestDevicePairing({
    deviceId: identity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
    clientId: "openclaw-cli",
    clientMode: "cli",
    role: "operator",
    scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals"],
    silent: false,
  });
  await approveDevicePairing(pending.request.requestId, {
    callerScopes: pending.request.scopes ?? ["operator.admin"],
  });
  server = await startGatewayServer(gatewayPort);
});

beforeEach(() => {
  openClawToolsTesting.setDepsForTest({
    callGateway: async (opts) => {
      return await callGateway({
        config: loadConfig(),
        token: getGatewayToken(),
        scopes: ["operator.admin"],
        ...opts,
      });
    },
  });
});

afterAll(async () => {
  await server.close();
  envSnapshot.restore();
  openClawToolsTesting.setDepsForTest();
});

describe("sessions_send gateway loopback", () => {
  it("returns reply when lifecycle ends before agent.wait", async () => {
    const spy = agentCommand as unknown as Mock<(opts: unknown) => Promise<void>>;
    spy.mockImplementation(async (opts: unknown) =>
      emitLifecycleAssistantReply({
        opts,
        defaultSessionId: "main",
        includeTimestamp: true,
        resolveText: (extraSystemPrompt) => {
          if (extraSystemPrompt?.includes("Agent-to-agent reply step")) {
            return "REPLY_SKIP";
          }
          if (extraSystemPrompt?.includes("Agent-to-agent announce step")) {
            return "ANNOUNCE_SKIP";
          }
          return "pong";
        },
      }),
    );

    const tool = getSessionsSendTool();

    const result = await tool.execute("call-loopback", {
      sessionKey: "main",
      message: "ping",
      timeoutSeconds: 5,
    });
    const details = result.details as {
      status?: string;
      reply?: string;
      sessionKey?: string;
    };
    expect(details).toMatchObject({
      status: "ok",
      reply: "pong",
      sessionKey: "main",
    });

    const firstCall = spy.mock.calls[0]?.[0] as
      | { lane?: string; inputProvenance?: { kind?: string; sourceTool?: string } }
      | undefined;
    expect(firstCall?.lane).toBe("nested");
    expect(firstCall?.inputProvenance).toMatchObject({
      kind: "inter_session",
      sourceTool: "sessions_send",
    });
  });
});

describe("sessions_send label lookup", () => {
  it(
    "finds session by label and sends message",
    { timeout: SESSION_SEND_E2E_TIMEOUT_MS },
    async () => {
      const spy = agentCommand as unknown as Mock<(opts: unknown) => Promise<void>>;
      spy.mockImplementation(async (opts: unknown) =>
        emitLifecycleAssistantReply({
          opts,
          defaultSessionId: "test-labeled",
          resolveText: () => "labeled response",
        }),
      );

      // First, create a session with a label via sessions.patch
      await callGateway({
        config: {} as OpenClawConfig,
        token: getGatewayToken(),
        method: "sessions.patch",
        params: { key: "test-labeled-session", label: "my-test-worker" },
        timeoutMs: 5000,
      });

      const baseConfig = loadConfig();
      const tool = createOpenClawTools({
        config: {
          ...baseConfig,
          tools: {
            ...baseConfig.tools,
            sessions: {
              ...baseConfig.tools?.sessions,
              visibility: "all",
            },
          },
        },
      }).find((candidate) => candidate.name === "sessions_send");
      if (!tool) {
        throw new Error("missing sessions_send tool");
      }

      // Send using label instead of sessionKey
      const result = await tool.execute("call-by-label", {
        label: "my-test-worker",
        message: "hello labeled session",
        timeoutSeconds: 5,
      });
      const details = result.details as {
        status?: string;
        reply?: string;
        sessionKey?: string;
      };
      expect(details).toMatchObject({
        status: "ok",
        reply: "labeled response",
        sessionKey: "agent:main:test-labeled-session",
      });
    },
  );
});
