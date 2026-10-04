// sessions_send tests cover tool-driven agent-to-agent delivery, transcript
// updates, gateway auth, plugin routing, and emitted agent events.
import fs from "node:fs/promises";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildAgentRunTerminalReplySnapshot } from "../agents/agent-run-terminal-reply.js";
import type { AgentCommandGatewayIngressOpts } from "../agents/command/types.js";
import {
  loadSessionEntry,
  persistSessionTranscriptTurn,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import { captureEnv } from "../test-utils/env.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { runDirectSessionReplyScenario } from "./server.sessions-send.direct-reply.test-support.js";
import {
  agentCommandMock,
  installGatewayTestHooks,
  prepareGatewayReplyRuntimeForTest,
  startTestGatewayServer,
  testState,
  writeSessionStore,
} from "./test-helpers.js";
import { releaseGatewaySessionStoreFixture } from "./test/server-sessions-resources.test-helpers.js";

const { createOpenClawTools } = await import("../agents/openclaw-tools.js");

installGatewayTestHooks({ scope: "suite" });

let server: Awaited<ReturnType<typeof startTestGatewayServer>>;
let kernel: Awaited<ReturnType<(typeof import("./server-kernel.js"))["createGatewayKernel"]>>;
let gatewayPort: number;
const gatewayToken = "test-gateway-token-1234567890";
let envSnapshot: ReturnType<typeof captureEnv>;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const dir of tempDirs.dirs) {
      await releaseGatewaySessionStoreFixture(dir);
    }
    cleanup();
  }),
);

const SESSION_SEND_E2E_TIMEOUT_MS = 10_000;
const SESSION_SEND_DM_ROUTING_E2E_TIMEOUT_MS = 30_000;

function getSessionsSendTool(options?: Parameters<typeof createOpenClawTools>[0]) {
  const tool = createOpenClawTools(options).find((candidate) => candidate.name === "sessions_send");
  if (!tool) {
    throw new Error("missing sessions_send tool");
  }
  return tool;
}

function expectSessionsSendDetails(
  result: { details?: unknown },
  expected: { reply: string; sessionKey: string },
): void {
  expect(result.details).toMatchObject({ status: "ok", ...expected });
}

async function writeConfig(config: OpenClawConfig) {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("OPENCLAW_CONFIG_PATH missing in gateway test environment");
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(config)}\n`, "utf-8");
}

async function emitLifecycleAssistantReply(params: {
  opts: unknown;
  defaultSessionId: string;
  includeTimestamp?: boolean;
  resolveText: (extraSystemPrompt?: string) => string;
}) {
  const commandParams = params.opts as {
    sessionId?: string;
    sessionKey?: string;
    runId?: string;
    agentId?: string;
    lifecycleGeneration?: string;
    extraSystemPrompt?: string;
  };
  const sessionId = commandParams.sessionId ?? params.defaultSessionId;
  const runId = commandParams.runId ?? sessionId;
  if (!commandParams.sessionKey) {
    throw new Error("expected session key for lifecycle reply");
  }

  const routing = {
    runId,
    sessionKey: commandParams.sessionKey,
    sessionId,
    agentId: commandParams.agentId,
    lifecycleGeneration: commandParams.lifecycleGeneration,
  };
  const startedAt = Date.now();
  emitAgentEvent({
    ...routing,
    stream: "lifecycle",
    data: { phase: "start", startedAt },
  });

  const text = params.resolveText(commandParams.extraSystemPrompt);
  const message = {
    role: "assistant",
    content: [{ type: "text", text }],
    ...(params.includeTimestamp ? { timestamp: Date.now() } : {}),
  };
  await persistSessionTranscriptTurn(
    {
      sessionId,
      sessionKey: commandParams.sessionKey,
      ...(testState.sessionStorePath ? { storePath: testState.sessionStorePath } : {}),
    },
    {
      cwd: "/tmp",
      updateMode: "none",
      messages: [{ message, now: Date.now() }],
    },
  );

  emitAgentEvent({
    ...routing,
    stream: "lifecycle",
    data: {
      phase: "end",
      startedAt,
      endedAt: Date.now(),
      terminalReply: buildAgentRunTerminalReplySnapshot({ visibleText: text, rawText: text }),
    },
  });
}

beforeAll(async () => {
  envSnapshot = captureEnv(["OPENCLAW_GATEWAY_PORT", "OPENCLAW_GATEWAY_TOKEN"]);
  const { approveDevicePairing } = await import("../infra/device-pairing-approval.js");
  const { requestDevicePairing } = await import("../infra/device-pairing.js");
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
  testState.gatewayAuth = { mode: "token", token: gatewayToken };
  const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
  gatewayPort = portClaim.port;
  process.env.OPENCLAW_GATEWAY_PORT = String(gatewayPort);
  process.env.OPENCLAW_GATEWAY_TOKEN = gatewayToken;
  const kernelModule = await import("./server-kernel.js");
  const createKernel = kernelModule.createGatewayKernel;
  const captureKernel = vi
    .spyOn(kernelModule, "createGatewayKernel")
    .mockImplementation(async (...args) => {
      kernel = await createKernel(...args);
      return kernel;
    });
  try {
    server = await startTestGatewayServer(portClaim);
  } finally {
    captureKernel.mockRestore();
  }
  // Prepare the real history handler before the RPC deadline starts.
  await import("./server-methods/chat.js");
});

beforeEach(async () => {
  testState.gatewayAuth = { mode: "token", token: gatewayToken };
  process.env.OPENCLAW_GATEWAY_PORT = String(gatewayPort);
  process.env.OPENCLAW_GATEWAY_TOKEN = gatewayToken;
  testState.sessionStorePath = path.join(
    tempDirs.make("openclaw-sessions-send-case-"),
    "sessions.json",
  );
  await writeSessionStore({ entries: {} });
  await prepareGatewayReplyRuntimeForTest();
});

// Detached replies retain their selected store until the owner has settled.
afterEach(
  async () => {
    await waitForGatewayActiveWork(SESSION_SEND_E2E_TIMEOUT_MS * 3);
  },
  SESSION_SEND_E2E_TIMEOUT_MS * 3 + 1_000,
);

afterAll(async () => {
  await server.close();
  envSnapshot.restore();
});

describe("sessions_send gateway loopback", () => {
  it("rejects a missing explicit key without creating or running a session", async () => {
    const dir = tempDirs.make("openclaw-sessions-send-missing-");
    const missingKey = "agent:main:missing";
    const spy = agentCommandMock as unknown as Mock<(opts: unknown) => Promise<void>>;
    testState.sessionStorePath = path.join(dir, "sessions.json");
    try {
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
      });
      spy.mockClear();
      const tool = getSessionsSendTool({
        agentSessionKey: "agent:main:main",
        config: { tools: { sessions: { visibility: "all" } } },
      });

      const result = await tool.execute("call-missing-key", {
        sessionKey: missingKey,
        message: "ping",
        timeoutSeconds: 0,
      });

      expect(result.details).toMatchObject({
        status: "error",
        error: `No session found: ${missingKey}`,
      });
      expect(spy).not.toHaveBeenCalled();
      expect(
        loadSessionEntry({ sessionKey: missingKey, storePath: testState.sessionStorePath }),
      ).toBe(undefined);
    } finally {
      testState.sessionStorePath = undefined;
    }
  });

  it("returns reply when lifecycle ends before agent.wait", async () => {
    const body = "    const first = 1;\n        const second = 2;";
    const spy = agentCommandMock as unknown as Mock<
      (opts: AgentCommandGatewayIngressOpts) => Promise<void>
    >;
    spy.mockImplementation(async (opts) => {
      await opts.userTurnTranscriptRecorder?.persistApproved();
      await emitLifecycleAssistantReply({
        opts,
        defaultSessionId: "main",
        includeTimestamp: true,
        resolveText: () => "pong",
      });
    });

    const tool = getSessionsSendTool();

    const result = await tool.execute("call-loopback", {
      sessionKey: "main",
      message: body,
      timeoutSeconds: 5,
    });
    expectSessionsSendDetails(result, { reply: "pong", sessionKey: "main" });

    const firstCall = spy.mock.calls.at(0)?.[0];
    expect(firstCall?.lane).toMatch(/^nested(?::|$)/);
    expect(firstCall?.inputProvenance?.kind).toBe("inter_session");
    expect(firstCall?.inputProvenance?.sourceTool).toBe("sessions_send");
    expect(firstCall?.runId).toBeTypeOf("string");
    expect(result.details).toMatchObject({ runId: firstCall?.runId });
    expect(firstCall?.userTurnTranscriptRecorder?.hasPersisted()).toBe(true);

    expect(spy).toHaveBeenCalledOnce();
    const { callGateway } = await import("./call.js");
    const history = await callGateway<{ messages?: unknown[] }>({
      method: "chat.history",
      params: { sessionKey: "main", limit: 10 },
      timeoutMs: 5_000,
    });
    // Observe both receiving and persisted body failures before ending the case.
    expect.soft(firstCall?.message?.split("\n").slice(-2).join("\n")).toBe(body);
    expect.soft(history.messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        idempotencyKey: `${firstCall?.runId}:user`,
        content: body,
        provenance: expect.objectContaining({
          kind: "inter_session",
          sourceTool: "sessions_send",
        }),
      }),
    );
  });

  it(
    "delivers a same-session reply to an account-scoped DM without stored delivery context",
    { timeout: SESSION_SEND_DM_ROUTING_E2E_TIMEOUT_MS },
    async () => {
      await runDirectSessionReplyScenario({
        dir: tempDirs.make("openclaw-direct-reply-"),
        resolveGatewayContext: () => kernel.gatewayRequestContext,
        sessionKey: "agent:main:feishu:work:dm:ou_reply_recipient",
        expectedAccountId: "work",
      });
    },
  );
});

describe("sessions_send label lookup", () => {
  it(
    "finds session by label and sends message",
    { timeout: SESSION_SEND_E2E_TIMEOUT_MS },
    async () => {
      await writeConfig({ tools: { sessions: { visibility: "all" } } });
      const spy = agentCommandMock as unknown as Mock<(opts: unknown) => Promise<void>>;
      spy.mockImplementation(async (opts: unknown) =>
        emitLifecycleAssistantReply({
          opts,
          defaultSessionId: "test-labeled",
          resolveText: () => "labeled response",
        }),
      );

      const { callGateway } = await import("./call.js");
      await callGateway({
        method: "sessions.patch",
        params: { key: "test-labeled-session", label: "my-test-worker" },
        timeoutMs: 5000,
      });

      const tool = getSessionsSendTool({
        config: { tools: { sessions: { visibility: "all" } } },
      });

      const result = await tool.execute("call-by-label", {
        label: "my-test-worker",
        message: "hello labeled session",
        timeoutSeconds: 5,
      });
      expectSessionsSendDetails(result, {
        reply: "labeled response",
        sessionKey: "agent:main:test-labeled-session",
      });
    },
  );
});

describe("sessions_send agent targeting", () => {
  it.each([
    { name: "default cross-agent access", tools: undefined },
    {
      name: "disabled agent-to-agent access",
      tools: { agentToAgent: { enabled: false } },
      error: "Agent-to-agent messaging is disabled",
    },
    {
      name: "restrictive allow list",
      tools: { agentToAgent: { allow: ["main"] } },
      error: "denied by tools.agentToAgent.allow",
    },
  ] satisfies Array<{ name: string; tools: OpenClawConfig["tools"]; error?: string }>)(
    "enforces $name when targeting a configured agent main session by agentId",
    async ({ tools, error }) => {
      const dir = tempDirs.make("openclaw-sessions-send-agent-");
      const config: OpenClawConfig = {
        ...(tools ? { tools } : {}),
        agents: {
          ownership: "explicit",
          defaults: {
            systemAgent: { agentId: "main" },
            sessionStore: { agentId: "main" },
          },
          entries: { main: {}, orion: {} },
        },
      };

      testState.sessionStorePath = path.join(dir, "sessions.json");
      testState.agentsConfig = config.agents;
      try {
        await writeConfig(config);
        await writeSessionStore({
          entries: {
            main: {
              sessionId: "sess-main",
              updatedAt: Date.now(),
            },
          },
        });
        await prepareGatewayReplyRuntimeForTest({ force: true });

        const spy = agentCommandMock as unknown as Mock<(opts: unknown) => Promise<void>>;
        spy.mockImplementation(async (opts: unknown) =>
          emitLifecycleAssistantReply({
            opts,
            defaultSessionId: "orion-created",
            resolveText: () => "orion response",
          }),
        );
        spy.mockClear();

        const tool = getSessionsSendTool({
          agentSessionKey: "agent:main:main",
          config,
        });

        const result = await tool.execute("call-agent-id", {
          agentId: "orion",
          message: "hello orion",
          timeoutSeconds: 5,
        });
        if (error) {
          expect(spy.mock.calls.map(([opts]) => opts)).not.toContainEqual(
            expect.objectContaining({ sessionKey: "agent:orion:main" }),
          );
          expect(
            loadSessionEntry({
              sessionKey: "agent:orion:main",
              storePath: testState.sessionStorePath,
            }),
          ).toBeUndefined();
          expect(result.details).toMatchObject({
            status: "forbidden",
            error: expect.stringContaining(error),
          });
          return;
        }
        expectSessionsSendDetails(result, {
          reply: "orion response",
          sessionKey: "agent:orion:main",
        });

        const orionCall = spy.mock.calls
          .map(([opts]) => opts as { sessionId?: string; sessionKey?: string })
          .find((call) => call.sessionKey === "agent:orion:main");
        expect(orionCall).toBeDefined();
        expect(orionCall?.sessionId).toBeTypeOf("string");

        const stored = loadSessionEntry({
          sessionKey: "agent:orion:main",
          storePath: testState.sessionStorePath,
        });
        expect(stored?.sessionId).toBe(orionCall?.sessionId);
      } finally {
        testState.agentsConfig = undefined;
      }
    },
    SESSION_SEND_E2E_TIMEOUT_MS,
  );
});
