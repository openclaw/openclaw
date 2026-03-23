import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentCommand,
  connectOk,
  installGatewayTestHooks,
  onceMessage,
  startServerWithClient,
  testState,
} from "./test-helpers.js";

const acpState = vi.hoisted(() => ({
  initializedSessions: new Set<string>(),
  initializeSession: vi.fn(async (_params: unknown) => ({})),
  resolveSession: vi.fn((_params: unknown) => ({ kind: "none" })),
  runTurn: vi.fn(async (_params: unknown) => {}),
  cancelSession: vi.fn(async (_params: unknown) => {}),
  closeSession: vi.fn(async (_params: unknown) => {}),
  reconcileSessionIdentities: vi.fn(async () => ({ checked: 0, resolved: 0, failed: 0 })),
}));

vi.mock("../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    initializeSession: (params: unknown) => acpState.initializeSession(params),
    resolveSession: (params: unknown) => acpState.resolveSession(params),
    runTurn: (params: unknown) => acpState.runTurn(params),
    cancelSession: (params: unknown) => acpState.cancelSession(params),
    closeSession: (params: unknown) => acpState.closeSession(params),
    reconcileSessionIdentities: () => acpState.reconcileSessionIdentities(),
  }),
}));

installGatewayTestHooks({ scope: "suite" });

let startedServer: Awaited<ReturnType<typeof startServerWithClient>> | null = null;
let sharedTempRoot: string;

function requireWs(): Awaited<ReturnType<typeof startServerWithClient>>["ws"] {
  if (!startedServer) {
    throw new Error("gateway test server not started");
  }
  return startedServer.ws;
}

async function writeGatewayConfig(config: Record<string, unknown>) {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("OPENCLAW_CONFIG_PATH is not set");
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
}

async function resetTempDir(name: string): Promise<string> {
  const dir = path.join(sharedTempRoot, name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

beforeAll(async () => {
  sharedTempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-agent-acp-"));
  startedServer = await startServerWithClient(undefined, { controlUiEnabled: true });
  await connectOk(requireWs());
});

beforeEach(async () => {
  acpState.initializedSessions.clear();
  acpState.initializeSession.mockReset();
  acpState.resolveSession.mockReset();
  acpState.runTurn.mockReset();
  acpState.cancelSession.mockReset();
  acpState.closeSession.mockReset();
  acpState.reconcileSessionIdentities.mockReset();

  const realAgentModule =
    await vi.importActual<typeof import("../commands/agent.js")>("../commands/agent.js");
  vi.mocked(agentCommand).mockImplementation(((opts: unknown, runtime: unknown, deps: unknown) =>
    realAgentModule.agentCommandFromIngress(
      opts as never,
      runtime as never,
      deps as never,
    )) as never);

  acpState.initializeSession.mockImplementation(async (paramsUnknown: unknown) => {
    const params = paramsUnknown as {
      sessionKey: string;
      agent: string;
      mode: string;
      cwd?: string;
      backendId?: string;
    };
    acpState.initializedSessions.add(params.sessionKey);
    return {
      runtime: {},
      handle: {
        sessionKey: params.sessionKey,
        backend: params.backendId ?? "acpx",
        runtimeSessionName: params.sessionKey,
        cwd: params.cwd,
      },
      meta: {
        backend: params.backendId ?? "acpx",
        agent: params.agent,
        runtimeSessionName: params.sessionKey,
        mode: params.mode,
        cwd: params.cwd,
        state: "idle",
        lastActivityAt: Date.now(),
      },
    };
  });
  acpState.resolveSession.mockImplementation((paramsUnknown: unknown) => {
    const params = paramsUnknown as { sessionKey: string };
    if (!acpState.initializedSessions.has(params.sessionKey)) {
      return { kind: "none", sessionKey: params.sessionKey };
    }
    return {
      kind: "ready",
      sessionKey: params.sessionKey,
      meta: {
        backend: "custom-acpx",
        agent: "codex",
        runtimeSessionName: params.sessionKey,
        mode: "persistent",
        state: "idle",
        lastActivityAt: Date.now(),
      },
    };
  });
  acpState.runTurn.mockImplementation(async (paramsUnknown: unknown) => {
    const params = paramsUnknown as {
      onEvent?: (event: {
        type: string;
        text?: string;
        stopReason?: string;
        stream?: string;
      }) => void;
    };
    params.onEvent?.({ type: "text_delta", text: "ACP_OK", stream: "output" });
    params.onEvent?.({ type: "done", stopReason: "stop" });
  });
  acpState.reconcileSessionIdentities.mockResolvedValue({ checked: 0, resolved: 0, failed: 0 });
});

afterAll(async () => {
  vi.mocked(agentCommand).mockReset();
  if (startedServer) {
    startedServer.ws.close();
    await startedServer.server.close();
    startedServer = null;
  }
  await fs.rm(sharedTempRoot, { recursive: true, force: true });
});

describe("gateway agent ACP round-trip", () => {
  it("auto-initializes ACP main sessions for runtime.type=acp agents over RPC", async () => {
    const dir = await resetTempDir("agent-rpc-acp-success");
    testState.sessionStorePath = path.join(dir, "sessions.json");
    const workspaceDir = path.join(dir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    await writeGatewayConfig({
      acp: {
        enabled: true,
        backend: "acpx",
        allowedAgents: ["codex"],
        dispatch: { enabled: true },
      },
      agents: {
        defaults: {
          workspace: workspaceDir,
          model: { primary: "openai/gpt-5.3-codex" },
          models: { "openai/gpt-5.3-codex": {} },
        },
        list: [
          {
            id: "codex",
            workspace: workspaceDir,
            runtime: {
              type: "acp",
              acp: {
                agent: "codex",
                backend: "custom-acpx",
                mode: "persistent",
                cwd: workspaceDir,
              },
            },
          },
        ],
      },
      session: {
        store: testState.sessionStorePath,
        mainKey: "main",
      },
    });

    const ws = requireWs();
    const id = randomUUID();
    const acceptedPromise = onceMessage(
      ws,
      (msg) =>
        msg.type === "res" &&
        msg.id === id &&
        msg.ok === true &&
        (msg.payload as { status?: string } | undefined)?.status === "accepted",
    );
    const completedPromise = onceMessage(
      ws,
      (msg) =>
        msg.type === "res" &&
        msg.id === id &&
        msg.ok === true &&
        (msg.payload as { status?: string } | undefined)?.status === "ok",
    );

    ws.send(
      JSON.stringify({
        type: "req",
        id,
        method: "agent",
        params: {
          message: "ping",
          agentId: "codex",
          idempotencyKey: `idem-${id}`,
        },
      }),
    );

    const accepted = await acceptedPromise;
    const completed = await completedPromise;

    expect((accepted.payload as { runId?: string } | undefined)?.runId).toBeTruthy();
    expect(acpState.initializeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:codex:main",
        agent: "codex",
        backendId: "custom-acpx",
        mode: "persistent",
        cwd: workspaceDir,
      }),
    );
    expect(acpState.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:codex:main",
        mode: "prompt",
      }),
    );
    expect(
      (acpState.runTurn.mock.calls[0]?.[0] as { text?: string } | undefined)?.text ?? "",
    ).toContain("ping");
    expect(
      (completed.payload as { result?: { payloads?: Array<{ text?: string }> } } | undefined)
        ?.result?.payloads?.[0]?.text,
    ).toBe("ACP_OK");
  });

  it("surfaces ACP dispatch policy failures in the terminal RPC response", async () => {
    const dir = await resetTempDir("agent-rpc-acp-dispatch-disabled");
    testState.sessionStorePath = path.join(dir, "sessions.json");
    const workspaceDir = path.join(dir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    await writeGatewayConfig({
      acp: {
        enabled: true,
        backend: "acpx",
        allowedAgents: ["codex"],
        dispatch: { enabled: false },
      },
      agents: {
        defaults: {
          workspace: workspaceDir,
          model: { primary: "openai/gpt-5.3-codex" },
          models: { "openai/gpt-5.3-codex": {} },
        },
        list: [
          {
            id: "codex",
            workspace: workspaceDir,
            runtime: {
              type: "acp",
              acp: {
                agent: "codex",
                mode: "persistent",
                cwd: workspaceDir,
              },
            },
          },
        ],
      },
      session: {
        store: testState.sessionStorePath,
        mainKey: "main",
      },
    });

    const ws = requireWs();
    const id = randomUUID();
    const acceptedPromise = onceMessage(
      ws,
      (msg) =>
        msg.type === "res" &&
        msg.id === id &&
        msg.ok === true &&
        (msg.payload as { status?: string } | undefined)?.status === "accepted",
    );
    const failedPromise = onceMessage(
      ws,
      (msg) =>
        msg.type === "res" &&
        msg.id === id &&
        msg.ok === false &&
        (msg.payload as { status?: string } | undefined)?.status === "error",
    );

    ws.send(
      JSON.stringify({
        type: "req",
        id,
        method: "agent",
        params: {
          message: "ping",
          agentId: "codex",
          idempotencyKey: `idem-${id}`,
        },
      }),
    );

    await acceptedPromise;
    const failed = await failedPromise;

    expect(acpState.initializeSession).not.toHaveBeenCalled();
    expect((failed.payload as { summary?: string } | undefined)?.summary ?? "").toContain(
      "ACP dispatch is disabled",
    );
    expect((failed.error as { message?: string } | undefined)?.message ?? "").toContain(
      "ACP dispatch is disabled",
    );
  });
});
