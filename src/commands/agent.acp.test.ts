import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import * as acpManagerModule from "../acp/control-plane/manager.js";
import { AcpRuntimeError } from "../acp/runtime/errors.js";
import * as embeddedModule from "../agents/pi-embedded.js";
import type { OpenClawConfig } from "../config/config.js";
import * as configModule from "../config/config.js";
import { readSessionMessages } from "../gateway/session-utils.fs.js";
import { onAgentEvent } from "../infra/agent-events.js";
import type { RuntimeEnv } from "../runtime.js";
import { agentCommand } from "./agent.js";

const loadConfigSpy = vi.spyOn(configModule, "loadConfig");
const runEmbeddedPiAgentSpy = vi.spyOn(embeddedModule, "runEmbeddedPiAgent");
const getAcpSessionManagerSpy = vi.spyOn(acpManagerModule, "getAcpSessionManager");

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(() => {
    throw new Error("exit");
  }),
};

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "openclaw-agent-acp-" });
}

function createAcpEnabledConfig(home: string, storePath: string): OpenClawConfig {
  return {
    acp: {
      enabled: true,
      backend: "acpx",
      allowedAgents: ["codex", "kimi"],
      dispatch: { enabled: true },
    },
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5.3-codex" },
        models: { "openai/gpt-5.3-codex": {} },
        workspace: path.join(home, "openclaw"),
      },
      list: [
        {
          id: "codex",
          workspace: path.join(home, "openclaw"),
          runtime: {
            type: "acp",
            acp: {
              agent: "codex",
              mode: "persistent",
            },
          },
        },
        {
          id: "kimi",
          workspace: path.join(home, "openclaw"),
          runtime: {
            type: "acp",
            acp: {
              agent: "kimi",
              mode: "persistent",
            },
          },
        },
      ],
    },
    session: { store: storePath, mainKey: "main" },
  };
}

function mockConfig(home: string, storePath: string) {
  loadConfigSpy.mockReturnValue(createAcpEnabledConfig(home, storePath));
}

function mockConfigWithAcpOverrides(
  home: string,
  storePath: string,
  acpOverrides: Partial<NonNullable<OpenClawConfig["acp"]>>,
) {
  const cfg = createAcpEnabledConfig(home, storePath);
  cfg.acp = {
    ...cfg.acp,
    ...acpOverrides,
  };
  loadConfigSpy.mockReturnValue(cfg);
}

function writeAcpSessionStore(storePath: string, agent = "codex") {
  const sessionKey = `agent:${agent}:acp:test`;
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(
    storePath,
    JSON.stringify(
      {
        [sessionKey]: {
          sessionId: "acp-session-1",
          updatedAt: Date.now(),
          acp: {
            backend: "acpx",
            agent,
            runtimeSessionName: sessionKey,
            mode: "oneshot",
            state: "idle",
            lastActivityAt: Date.now(),
          },
        },
      },
      null,
      2,
    ),
  );
}

function resolveReadySession(
  sessionKey: string,
  agent = "codex",
): ReturnType<ReturnType<typeof acpManagerModule.getAcpSessionManager>["resolveSession"]> {
  return {
    kind: "ready",
    sessionKey,
    meta: {
      backend: "acpx",
      agent,
      runtimeSessionName: sessionKey,
      mode: "oneshot",
      state: "idle",
      lastActivityAt: Date.now(),
    },
  };
}

function mockAcpManager(params: {
  initializeSession?: (params: unknown) => Promise<unknown>;
  runTurn: (params: unknown) => Promise<void>;
  resolveSession?: (params: {
    cfg: OpenClawConfig;
    sessionKey: string;
  }) => ReturnType<ReturnType<typeof acpManagerModule.getAcpSessionManager>["resolveSession"]>;
}) {
  getAcpSessionManagerSpy.mockReturnValue({
    initializeSession:
      params.initializeSession ??
      (async () => {
        throw new Error("initializeSession should not be called");
      }),
    runTurn: params.runTurn,
    resolveSession:
      params.resolveSession ??
      ((input) => {
        return resolveReadySession(input.sessionKey);
      }),
  } as unknown as ReturnType<typeof acpManagerModule.getAcpSessionManager>);
}

async function withAcpSessionEnv(fn: () => Promise<void>) {
  await withTempHome(async (home) => {
    const storePath = path.join(home, "sessions.json");
    writeAcpSessionStore(storePath);
    mockConfig(home, storePath);
    await fn();
  });
}

async function withAcpSessionEnvInfo(
  fn: (env: { home: string; storePath: string }) => Promise<void>,
) {
  await withTempHome(async (home) => {
    const storePath = path.join(home, "sessions.json");
    writeAcpSessionStore(storePath);
    mockConfig(home, storePath);
    await fn({ home, storePath });
  });
}

function createRunTurnFromTextDeltas(chunks: string[]) {
  return vi.fn(async (paramsUnknown: unknown) => {
    const params = paramsUnknown as {
      onEvent?: (event: { type: string; text?: string; stopReason?: string }) => Promise<void>;
    };
    for (const text of chunks) {
      await params.onEvent?.({ type: "text_delta", text });
    }
    await params.onEvent?.({ type: "done", stopReason: "stop" });
  });
}

function subscribeAssistantEvents() {
  const assistantEvents: Array<{ text?: string; delta?: string }> = [];
  const stop = onAgentEvent((evt) => {
    if (evt.stream !== "assistant") {
      return;
    }
    assistantEvents.push({
      text: typeof evt.data?.text === "string" ? evt.data.text : undefined,
      delta: typeof evt.data?.delta === "string" ? evt.data.delta : undefined,
    });
  });
  return { assistantEvents, stop };
}

async function runAcpTurnWithAssistantEvents(chunks: string[]) {
  const { assistantEvents, stop } = subscribeAssistantEvents();
  const runTurn = createRunTurnFromTextDeltas(chunks);

  mockAcpManager({
    runTurn: (params: unknown) => runTurn(params),
  });

  try {
    await agentCommand({ message: "ping", sessionKey: "agent:codex:acp:test" }, runtime);
  } finally {
    stop();
  }

  const logLines = vi.mocked(runtime.log).mock.calls.map(([first]) => String(first));
  return { assistantEvents, logLines };
}

async function runAcpTurnWithTextDeltas(params: { message?: string; chunks: string[] }) {
  const runTurn = createRunTurnFromTextDeltas(params.chunks);
  mockAcpManager({
    runTurn: (input: unknown) => runTurn(input),
  });
  await agentCommand(
    {
      message: params.message ?? "ping",
      sessionKey: "agent:codex:acp:test",
    },
    runtime,
  );
  return { runTurn };
}

function expectPersistedAcpTranscript(params: {
  storePath: string;
  userContent: string;
  assistantText: string;
}) {
  const persistedStore = JSON.parse(fs.readFileSync(params.storePath, "utf-8")) as Record<
    string,
    { sessionFile?: string }
  >;
  const sessionFile = persistedStore["agent:codex:acp:test"]?.sessionFile;
  const messages = readSessionMessages("acp-session-1", params.storePath, sessionFile);
  expect(messages).toHaveLength(2);
  expect(messages[0]).toMatchObject({
    role: "user",
    content: params.userContent,
  });
  expect(messages[1]).toMatchObject({
    role: "assistant",
    content: [{ type: "text", text: params.assistantText }],
  });
}

async function runAcpSessionWithPolicyOverrides(params: {
  acpOverrides: Partial<NonNullable<OpenClawConfig["acp"]>>;
  resolveSession?: Parameters<typeof mockAcpManager>[0]["resolveSession"];
}) {
  await withTempHome(async (home) => {
    const storePath = path.join(home, "sessions.json");
    writeAcpSessionStore(storePath);
    mockConfigWithAcpOverrides(home, storePath, params.acpOverrides);

    const runTurn = vi.fn(async (_params: unknown) => {});
    mockAcpManager({
      runTurn: (input: unknown) => runTurn(input),
      ...(params.resolveSession ? { resolveSession: params.resolveSession } : {}),
    });

    await expect(
      agentCommand({ message: "ping", sessionKey: "agent:codex:acp:test" }, runtime),
    ).rejects.toMatchObject({
      code: "ACP_DISPATCH_DISABLED",
    });
    expect(runTurn).not.toHaveBeenCalled();
    expect(runEmbeddedPiAgentSpy).not.toHaveBeenCalled();
  });
}

describe("agentCommand ACP runtime routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runEmbeddedPiAgentSpy.mockResolvedValue({
      payloads: [{ text: "embedded" }],
      meta: {
        durationMs: 5,
      },
    } as never);
  });

  it("routes ACP sessions through AcpSessionManager instead of embedded agent", async () => {
    await withAcpSessionEnv(async () => {
      const { runTurn } = await runAcpTurnWithTextDeltas({ chunks: ["ACP_", "OK"] });

      expect(runTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:codex:acp:test",
          text: "ping",
          mode: "prompt",
        }),
      );
      expect(runEmbeddedPiAgentSpy).not.toHaveBeenCalled();
      const hasAckLog = vi
        .mocked(runtime.log)
        .mock.calls.some(([first]) => typeof first === "string" && first.includes("ACP_OK"));
      expect(hasAckLog).toBe(true);
    });
  });

  it("auto-initializes an ACP main session for agents configured with runtime.type=acp", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath, JSON.stringify({}, null, 2));
      const cfg = createAcpEnabledConfig(home, storePath);
      if (cfg.agents?.list?.[0]?.runtime?.type === "acp") {
        cfg.agents.list[0].runtime.acp = {
          ...cfg.agents.list[0].runtime.acp,
          backend: "custom-acpx",
          cwd: "~/openclaw",
        };
      }
      loadConfigSpy.mockReturnValue(cfg);

      let initialized = false;
      const initializeSession = vi.fn(async (paramsUnknown: unknown) => {
        const params = paramsUnknown as {
          sessionKey: string;
          agent: string;
          mode: string;
          cwd?: string;
        };
        initialized = true;
        const store = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<string, unknown>;
        const nextEntry = {
          sessionId: "acp-main-1",
          updatedAt: Date.now(),
          acp: {
            backend: "acpx",
            agent: params.agent,
            runtimeSessionName: params.sessionKey,
            mode: params.mode,
            cwd: params.cwd,
            state: "idle",
            lastActivityAt: Date.now(),
          },
        };
        store[params.sessionKey] = nextEntry;
        fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
        return {
          runtime: {},
          handle: {
            sessionKey: params.sessionKey,
            backend: "acpx",
            runtimeSessionName: params.sessionKey,
            cwd: params.cwd,
          },
          meta: nextEntry.acp,
        };
      });
      const runTurn = createRunTurnFromTextDeltas(["ACP_", "OK"]);

      mockAcpManager({
        initializeSession: (params: unknown) => initializeSession(params),
        runTurn: (params: unknown) => runTurn(params),
        resolveSession: ({ sessionKey }) =>
          initialized ? resolveReadySession(sessionKey, "codex") : { kind: "none", sessionKey },
      });

      await agentCommand({ message: "ping", agentId: "codex" }, runtime);

      expect(initializeSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:codex:main",
          agent: "codex",
          backendId: "custom-acpx",
          mode: "persistent",
          cwd: path.join(home, "openclaw"),
        }),
      );
      expect(runTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:codex:main",
          text: "ping",
          mode: "prompt",
        }),
      );
      expect(runEmbeddedPiAgentSpy).not.toHaveBeenCalled();

      const persistedStore = JSON.parse(fs.readFileSync(storePath, "utf-8")) as Record<
        string,
        { sessionId?: string; acp?: { backend?: string; agent?: string } }
      >;
      expect(persistedStore["agent:codex:main"]).toMatchObject({
        sessionId: "acp-main-1",
        acp: {
          backend: "acpx",
          agent: "codex",
        },
      });
    });
  });

  it("reuses an existing ACP main session for runtime.type=acp agents without reinitializing", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(
        storePath,
        JSON.stringify(
          {
            "agent:codex:main": {
              sessionId: "acp-main-existing",
              updatedAt: Date.now(),
              acp: {
                backend: "acpx",
                agent: "codex",
                runtimeSessionName: "agent:codex:main",
                mode: "persistent",
                state: "idle",
                lastActivityAt: Date.now(),
              },
            },
          },
          null,
          2,
        ),
      );
      mockConfig(home, storePath);

      const runTurn = createRunTurnFromTextDeltas(["ACP_", "OK"]);
      const initializeSession = vi.fn(async (_params: unknown) => ({}));
      mockAcpManager({
        initializeSession: (params: unknown) => initializeSession(params),
        runTurn: (params: unknown) => runTurn(params),
        resolveSession: ({ sessionKey }) => resolveReadySession(sessionKey, "codex"),
      });

      await agentCommand({ message: "ping", agentId: "codex" }, runtime);

      expect(initializeSession).not.toHaveBeenCalled();
      expect(runTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:codex:main",
          text: "ping",
          mode: "prompt",
        }),
      );
      expect(runEmbeddedPiAgentSpy).not.toHaveBeenCalled();
    });
  });

  it("fails closed for runtime.type=acp agents when ACP dispatch is disabled", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath, JSON.stringify({}, null, 2));
      mockConfigWithAcpOverrides(home, storePath, {
        dispatch: { enabled: false },
      });

      const initializeSession = vi.fn(async (_params: unknown) => ({}));
      const runTurn = vi.fn(async (_params: unknown) => {});
      mockAcpManager({
        initializeSession: (params: unknown) => initializeSession(params),
        runTurn: (params: unknown) => runTurn(params),
        resolveSession: ({ sessionKey }) => ({ kind: "none", sessionKey }),
      });

      await expect(
        agentCommand({ message: "ping", agentId: "codex" }, runtime),
      ).rejects.toMatchObject({
        code: "ACP_DISPATCH_DISABLED",
      });
      expect(initializeSession).not.toHaveBeenCalled();
      expect(runTurn).not.toHaveBeenCalled();
      expect(runEmbeddedPiAgentSpy).not.toHaveBeenCalled();
    });
  });

  it("persists ACP child session history to the transcript store", async () => {
    await withAcpSessionEnvInfo(async ({ storePath }) => {
      await runAcpTurnWithTextDeltas({ chunks: ["ACP_", "OK"] });
      expectPersistedAcpTranscript({
        storePath,
        userContent: "ping",
        assistantText: "ACP_OK",
      });
    });
  });

  it("preserves exact ACP transcript text without trimming whitespace", async () => {
    await withAcpSessionEnvInfo(async ({ storePath }) => {
      await runAcpTurnWithTextDeltas({
        message: "  ping\n",
        chunks: ["  ACP_OK\n"],
      });
      expectPersistedAcpTranscript({
        storePath,
        userContent: "  ping\n",
        assistantText: "  ACP_OK\n",
      });
    });
  });

  it("suppresses ACP NO_REPLY lead fragments before emitting assistant text", async () => {
    await withAcpSessionEnv(async () => {
      const { assistantEvents, logLines } = await runAcpTurnWithAssistantEvents([
        "NO",
        "NO_",
        "NO_RE",
        "NO_REPLY",
        "Actual answer",
      ]);

      expect(assistantEvents).toEqual([{ text: "Actual answer", delta: "Actual answer" }]);
      expect(logLines.some((line) => line.includes("NO_REPLY"))).toBe(false);
      expect(logLines.some((line) => line.includes("Actual answer"))).toBe(true);
    });
  });

  it("keeps silent-only ACP turns out of assistant output", async () => {
    await withAcpSessionEnv(async () => {
      const { assistantEvents, logLines } = await runAcpTurnWithAssistantEvents([
        "NO",
        "NO_",
        "NO_RE",
        "NO_REPLY",
      ]);
      expect(assistantEvents.map((event) => event.text).filter(Boolean)).toEqual([]);
      expect(logLines.some((line) => line.includes("NO_REPLY"))).toBe(false);
      expect(logLines.some((line) => line.includes("No reply from agent."))).toBe(true);
    });
  });

  it("preserves repeated identical ACP delta chunks", async () => {
    await withAcpSessionEnv(async () => {
      const { assistantEvents, logLines } = await runAcpTurnWithAssistantEvents([
        "b",
        "o",
        "o",
        "k",
      ]);

      expect(assistantEvents).toEqual([
        { text: "b", delta: "b" },
        { text: "bo", delta: "o" },
        { text: "boo", delta: "o" },
        { text: "book", delta: "k" },
      ]);
      expect(logLines.some((line) => line.includes("book"))).toBe(true);
    });
  });

  it("re-emits buffered NO prefix when ACP text becomes visible content", async () => {
    await withAcpSessionEnv(async () => {
      const { assistantEvents, logLines } = await runAcpTurnWithAssistantEvents(["NO", "W"]);

      expect(assistantEvents).toEqual([{ text: "NOW", delta: "NOW" }]);
      expect(logLines.some((line) => line.includes("NOW"))).toBe(true);
    });
  });

  it("fails closed for ACP-shaped session keys missing ACP metadata", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(
        storePath,
        JSON.stringify(
          {
            "agent:codex:acp:stale": {
              sessionId: "stale-1",
              updatedAt: Date.now(),
            },
          },
          null,
          2,
        ),
      );
      mockConfig(home, storePath);

      const runTurn = vi.fn(async (_params: unknown) => {});
      mockAcpManager({
        runTurn: (params: unknown) => runTurn(params),
        resolveSession: ({ sessionKey }) => {
          return {
            kind: "stale",
            sessionKey,
            error: new AcpRuntimeError(
              "ACP_SESSION_INIT_FAILED",
              `ACP metadata is missing for session ${sessionKey}.`,
            ),
          };
        },
      });

      await expect(
        agentCommand({ message: "ping", sessionKey: "agent:codex:acp:stale" }, runtime),
      ).rejects.toMatchObject({
        code: "ACP_SESSION_INIT_FAILED",
        message: expect.stringContaining("ACP metadata is missing"),
      });
      expect(runTurn).not.toHaveBeenCalled();
      expect(runEmbeddedPiAgentSpy).not.toHaveBeenCalled();
    });
  });

  it.each([
    {
      name: "blocks ACP turns when ACP is disabled by policy",
      acpOverrides: { enabled: false } satisfies Partial<NonNullable<OpenClawConfig["acp"]>>,
    },
    {
      name: "blocks ACP turns when ACP dispatch is disabled by policy",
      acpOverrides: {
        dispatch: { enabled: false },
      } satisfies Partial<NonNullable<OpenClawConfig["acp"]>>,
    },
  ])("$name", async ({ acpOverrides }) => {
    await runAcpSessionWithPolicyOverrides({ acpOverrides });
  });

  it("blocks ACP turns when ACP agent is disallowed by policy", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      writeAcpSessionStore(storePath);
      mockConfigWithAcpOverrides(home, storePath, {
        allowedAgents: ["claude"],
      });

      const runTurn = vi.fn(async (_params: unknown) => {});
      mockAcpManager({
        runTurn: (params: unknown) => runTurn(params),
        resolveSession: ({ sessionKey }) => resolveReadySession(sessionKey, "codex"),
      });

      await expect(
        agentCommand({ message: "ping", sessionKey: "agent:codex:acp:test" }, runtime),
      ).rejects.toMatchObject({
        code: "ACP_SESSION_INIT_FAILED",
        message: expect.stringContaining("not allowed by policy"),
      });
      expect(runTurn).not.toHaveBeenCalled();
      expect(runEmbeddedPiAgentSpy).not.toHaveBeenCalled();
    });
  });

  it("allows ACP turns for kimi when policy allowlists kimi", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      writeAcpSessionStore(storePath, "kimi");
      mockConfigWithAcpOverrides(home, storePath, {
        allowedAgents: ["kimi"],
      });

      const runTurn = vi.fn(async (_params: unknown) => {});
      mockAcpManager({
        runTurn: (params: unknown) => runTurn(params),
        resolveSession: ({ sessionKey }) => resolveReadySession(sessionKey, "kimi"),
      });

      await agentCommand({ message: "ping", sessionKey: "agent:kimi:acp:test" }, runtime);

      expect(runTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:kimi:acp:test",
          text: "ping",
        }),
      );
      expect(runEmbeddedPiAgentSpy).not.toHaveBeenCalled();
    });
  });
});
