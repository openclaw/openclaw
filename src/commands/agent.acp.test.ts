import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import * as acpManagerModule from "../acp/control-plane/manager.js";
import { AcpRuntimeError } from "../acp/runtime/errors.js";
import { readAcpSessionEntry, upsertAcpSessionMeta } from "../acp/runtime/session-meta.js";
import * as embeddedModule from "../agents/pi-embedded.js";
import type { OpenClawConfig } from "../config/config.js";
import * as configModule from "../config/config.js";
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
    storeSessionKey: sessionKey,
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
  runTurn: (params: unknown) => Promise<void>;
  resolveSession?: (params: {
    cfg: OpenClawConfig;
    sessionKey: string;
  }) => ReturnType<ReturnType<typeof acpManagerModule.getAcpSessionManager>["resolveSession"]>;
}) {
  getAcpSessionManagerSpy.mockReturnValue({
    runTurn: params.runTurn,
    resolveSession:
      params.resolveSession ??
      ((input) => {
        return resolveReadySession(input.sessionKey);
      }),
  } as unknown as ReturnType<typeof acpManagerModule.getAcpSessionManager>);
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
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      writeAcpSessionStore(storePath);
      mockConfig(home, storePath);

      const runTurn = vi.fn(async (paramsUnknown: unknown) => {
        const params = paramsUnknown as {
          onEvent?: (event: { type: string; text?: string; stopReason?: string }) => Promise<void>;
        };
        await params.onEvent?.({ type: "text_delta", text: "ACP_" });
        await params.onEvent?.({ type: "text_delta", text: "OK" });
        await params.onEvent?.({ type: "done", stopReason: "stop" });
      });

      mockAcpManager({
        runTurn: (params: unknown) => runTurn(params),
      });

      await agentCommand({ message: "ping", sessionKey: "agent:codex:acp:test" }, runtime);

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

  it("uses canonical ACP session keys returned by the manager", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      writeAcpSessionStore(storePath, "main");
      mockConfigWithAcpOverrides(home, storePath, {
        allowedAgents: ["main"],
      });

      const runTurn = vi.fn(async (_params: unknown) => {});
      mockAcpManager({
        runTurn: (params: unknown) => runTurn(params),
        resolveSession: () => resolveReadySession("agent:main:acp:test", "main"),
      });

      await agentCommand({ message: "ping", sessionKey: "main" }, runtime);

      expect(runTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          rawSessionKey: "main",
          sessionKey: "agent:main:acp:test",
          text: "ping",
        }),
      );
      expect(runEmbeddedPiAgentSpy).not.toHaveBeenCalled();
    });
  });

  it("preserves raw non-default agent aliases when the manager resolves a canonical ACP key", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath, JSON.stringify({}, null, 2));

      const cfg = createAcpEnabledConfig(home, storePath);
      cfg.session = { store: storePath, mainKey: "desk" };
      cfg.acp = {
        ...cfg.acp,
        allowedAgents: ["helper"],
      };
      loadConfigSpy.mockReturnValue(cfg);

      const runTurn = vi.fn(async (_params: unknown) => {});
      mockAcpManager({
        runTurn: (params: unknown) => runTurn(params),
        resolveSession: () => resolveReadySession("agent:helper:desk", "helper"),
      });

      await agentCommand({ message: "ping", sessionKey: "agent:helper:main" }, runtime);

      expect(runTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          rawSessionKey: "agent:helper:main",
          sessionKey: "agent:helper:desk",
          text: "ping",
        }),
      );
      expect(runEmbeddedPiAgentSpy).not.toHaveBeenCalled();
    });
  });

  it("reads ACP metadata from legacy main alias keys before canonical migration", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      const now = Date.now();
      fs.writeFileSync(
        storePath,
        JSON.stringify(
          {
            main: {
              sessionId: "acp-main-legacy",
              updatedAt: now,
              acp: {
                backend: "acpx",
                agent: "main",
                runtimeSessionName: "legacy-main",
                mode: "persistent",
                state: "idle",
                lastActivityAt: now,
              },
            },
          },
          null,
          2,
        ),
      );
      const cfg = createAcpEnabledConfig(home, storePath);

      const entry = readAcpSessionEntry({
        cfg,
        sessionKey: "main",
      });

      expect(entry?.sessionKey).toBe("agent:main:main");
      expect(entry?.storeSessionKey).toBe("main");
      expect(entry?.acp?.backend).toBe("acpx");
    });
  });

  it("clears ACP metadata stored under legacy main alias keys", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      const now = Date.now();
      fs.writeFileSync(
        storePath,
        JSON.stringify(
          {
            main: {
              sessionId: "acp-main-legacy",
              updatedAt: now,
              acp: {
                backend: "acpx",
                agent: "main",
                runtimeSessionName: "legacy-main",
                mode: "persistent",
                state: "idle",
                lastActivityAt: now,
              },
            },
          },
          null,
          2,
        ),
      );
      const cfg = createAcpEnabledConfig(home, storePath);

      await upsertAcpSessionMeta({
        cfg,
        sessionKey: "main",
        mutate: () => null,
      });

      const store = JSON.parse(fs.readFileSync(storePath, "utf-8")) as {
        main?: { acp?: unknown };
      };
      expect(store.main?.acp).toBeUndefined();
    });
  });

  it("updates ACP metadata in place for legacy non-default main aliases", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      const now = Date.now();
      fs.writeFileSync(
        storePath,
        JSON.stringify(
          {
            "agent:helper:main": {
              sessionId: "acp-helper-legacy",
              updatedAt: now,
              acp: {
                backend: "acpx",
                agent: "helper",
                runtimeSessionName: "legacy-helper-main",
                mode: "persistent",
                state: "idle",
                lastActivityAt: now,
              },
            },
          },
          null,
          2,
        ),
      );
      const cfg = createAcpEnabledConfig(home, storePath);
      cfg.session = { store: storePath, mainKey: "desk" };
      cfg.acp = {
        ...cfg.acp,
        allowedAgents: ["helper"],
      };

      await upsertAcpSessionMeta({
        cfg,
        sessionKey: "agent:helper:desk",
        rawSessionKey: "agent:helper:main",
        mutate: (current, entry) => ({
          ...(current ?? entry?.acp),
          backend: "acpx",
          agent: "helper",
          runtimeSessionName: "legacy-helper-main",
          mode: "persistent",
          state: "running",
          lastActivityAt: now + 1,
        }),
      });

      const store = JSON.parse(fs.readFileSync(storePath, "utf-8")) as Record<
        string,
        { acp?: { state?: string } }
      >;
      expect(Object.keys(store)).toEqual(["agent:helper:main"]);
      expect(store["agent:helper:main"]?.acp?.state).toBe("running");
      expect(store["agent:helper:desk"]).toBeUndefined();
    });
  });

  it("keeps legacy alias entries active during ACP upserts under disk-budget enforcement", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      const now = Date.now();
      fs.writeFileSync(
        storePath,
        JSON.stringify(
          {
            "agent:helper:main": {
              sessionId: "acp-helper-budget",
              updatedAt: now - 60_000,
              displayName: "x".repeat(4096),
              acp: {
                backend: "acpx",
                agent: "helper",
                runtimeSessionName: "legacy-helper-main",
                mode: "persistent",
                state: "idle",
                lastActivityAt: now - 60_000,
              },
            },
          },
          null,
          2,
        ),
      );

      const cfg = createAcpEnabledConfig(home, storePath);
      cfg.session = {
        store: storePath,
        mainKey: "desk",
        maintenance: {
          mode: "enforce",
          maxDiskBytes: "300b",
          highWaterBytes: "200b",
        },
      };
      cfg.acp = {
        ...cfg.acp,
        allowedAgents: ["helper"],
      };
      loadConfigSpy.mockReturnValue(cfg);

      await upsertAcpSessionMeta({
        cfg,
        sessionKey: "agent:helper:desk",
        rawSessionKey: "agent:helper:main",
        mutate: (current, entry) => ({
          ...(current ?? entry?.acp),
          backend: "acpx",
          agent: "helper",
          runtimeSessionName: "legacy-helper-main",
          mode: "persistent",
          state: "running",
          lastActivityAt: now + 1,
        }),
      });

      const store = JSON.parse(fs.readFileSync(storePath, "utf-8")) as Record<
        string,
        { acp?: { state?: string } }
      >;
      expect(Object.keys(store)).toEqual(["agent:helper:main"]);
      expect(store["agent:helper:main"]?.acp?.state).toBe("running");
    });
  });

  it("suppresses ACP NO_REPLY lead fragments before emitting assistant text", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      writeAcpSessionStore(storePath);
      mockConfig(home, storePath);

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

      const runTurn = vi.fn(async (paramsUnknown: unknown) => {
        const params = paramsUnknown as {
          onEvent?: (event: { type: string; text?: string; stopReason?: string }) => Promise<void>;
        };
        for (const text of ["NO", "NO_", "NO_RE", "NO_REPLY", "Actual answer"]) {
          await params.onEvent?.({ type: "text_delta", text });
        }
        await params.onEvent?.({ type: "done", stopReason: "stop" });
      });

      mockAcpManager({
        runTurn: (params: unknown) => runTurn(params),
      });

      try {
        await agentCommand({ message: "ping", sessionKey: "agent:codex:acp:test" }, runtime);
      } finally {
        stop();
      }

      expect(assistantEvents).toEqual([{ text: "Actual answer", delta: "Actual answer" }]);

      const logLines = vi.mocked(runtime.log).mock.calls.map(([first]) => String(first));
      expect(logLines.some((line) => line.includes("NO_REPLY"))).toBe(false);
      expect(logLines.some((line) => line.includes("Actual answer"))).toBe(true);
    });
  });

  it("keeps silent-only ACP turns out of assistant output", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      writeAcpSessionStore(storePath);
      mockConfig(home, storePath);

      const assistantEvents: string[] = [];
      const stop = onAgentEvent((evt) => {
        if (evt.stream !== "assistant") {
          return;
        }
        if (typeof evt.data?.text === "string") {
          assistantEvents.push(evt.data.text);
        }
      });

      const runTurn = vi.fn(async (paramsUnknown: unknown) => {
        const params = paramsUnknown as {
          onEvent?: (event: { type: string; text?: string; stopReason?: string }) => Promise<void>;
        };
        for (const text of ["NO", "NO_", "NO_RE", "NO_REPLY"]) {
          await params.onEvent?.({ type: "text_delta", text });
        }
        await params.onEvent?.({ type: "done", stopReason: "stop" });
      });

      mockAcpManager({
        runTurn: (params: unknown) => runTurn(params),
      });

      try {
        await agentCommand({ message: "ping", sessionKey: "agent:codex:acp:test" }, runtime);
      } finally {
        stop();
      }

      expect(assistantEvents).toEqual([]);

      const logLines = vi.mocked(runtime.log).mock.calls.map(([first]) => String(first));
      expect(logLines.some((line) => line.includes("NO_REPLY"))).toBe(false);
      expect(logLines.some((line) => line.includes("No reply from agent."))).toBe(true);
    });
  });

  it("preserves repeated identical ACP delta chunks", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      writeAcpSessionStore(storePath);
      mockConfig(home, storePath);

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

      const runTurn = vi.fn(async (paramsUnknown: unknown) => {
        const params = paramsUnknown as {
          onEvent?: (event: { type: string; text?: string; stopReason?: string }) => Promise<void>;
        };
        for (const text of ["b", "o", "o", "k"]) {
          await params.onEvent?.({ type: "text_delta", text });
        }
        await params.onEvent?.({ type: "done", stopReason: "stop" });
      });

      mockAcpManager({
        runTurn: (params: unknown) => runTurn(params),
      });

      try {
        await agentCommand({ message: "ping", sessionKey: "agent:codex:acp:test" }, runtime);
      } finally {
        stop();
      }

      expect(assistantEvents).toEqual([
        { text: "b", delta: "b" },
        { text: "bo", delta: "o" },
        { text: "boo", delta: "o" },
        { text: "book", delta: "k" },
      ]);

      const logLines = vi.mocked(runtime.log).mock.calls.map(([first]) => String(first));
      expect(logLines.some((line) => line.includes("book"))).toBe(true);
    });
  });

  it("re-emits buffered NO prefix when ACP text becomes visible content", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      writeAcpSessionStore(storePath);
      mockConfig(home, storePath);

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

      const runTurn = vi.fn(async (paramsUnknown: unknown) => {
        const params = paramsUnknown as {
          onEvent?: (event: { type: string; text?: string; stopReason?: string }) => Promise<void>;
        };
        for (const text of ["NO", "W"]) {
          await params.onEvent?.({ type: "text_delta", text });
        }
        await params.onEvent?.({ type: "done", stopReason: "stop" });
      });

      mockAcpManager({
        runTurn: (params: unknown) => runTurn(params),
      });

      try {
        await agentCommand({ message: "ping", sessionKey: "agent:codex:acp:test" }, runtime);
      } finally {
        stop();
      }

      expect(assistantEvents).toEqual([{ text: "NOW", delta: "NOW" }]);

      const logLines = vi.mocked(runtime.log).mock.calls.map(([first]) => String(first));
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
