import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import * as acpManagerModule from "../acp/control-plane/manager.js";
import { AcpRuntimeError } from "../acp/runtime/errors.js";
import * as embeddedModule from "../agents/pi-embedded.js";
import type { OpenClawConfig } from "../config/config.js";
import * as configModule from "../config/config.js";
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

function mockConfig(home: string, storePath: string) {
  loadConfigSpy.mockReturnValue({
    acp: {
      enabled: true,
      backend: "acpx",
      allowedAgents: ["codex"],
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
  } satisfies OpenClawConfig);
}

function mockConfigWithAcpOverrides(
  home: string,
  storePath: string,
  acpOverrides: Partial<NonNullable<OpenClawConfig["acp"]>>,
) {
  loadConfigSpy.mockReturnValue({
    acp: {
      enabled: true,
      backend: "acpx",
      allowedAgents: ["codex"],
      dispatch: { enabled: true },
      ...acpOverrides,
    },
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5.3-codex" },
        models: { "openai/gpt-5.3-codex": {} },
        workspace: path.join(home, "openclaw"),
      },
    },
    session: { store: storePath, mainKey: "main" },
  } satisfies OpenClawConfig);
}

function writeAcpSessionStore(storePath: string) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(
    storePath,
    JSON.stringify(
      {
        "agent:codex:acp:test": {
          sessionId: "acp-session-1",
          updatedAt: Date.now(),
          acp: {
            backend: "acpx",
            agent: "codex",
            runtimeSessionName: "agent:codex:acp:test",
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

  it("blocks ACP turns when ACP is disabled by policy", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      writeAcpSessionStore(storePath);
      mockConfigWithAcpOverrides(home, storePath, {
        enabled: false,
      });

      const runTurn = vi.fn(async (_params: unknown) => {});
      mockAcpManager({
        runTurn: (params: unknown) => runTurn(params),
      });

      await expect(
        agentCommand({ message: "ping", sessionKey: "agent:codex:acp:test" }, runtime),
      ).rejects.toMatchObject({
        code: "ACP_DISPATCH_DISABLED",
      });
      expect(runTurn).not.toHaveBeenCalled();
      expect(runEmbeddedPiAgentSpy).not.toHaveBeenCalled();
    });
  });

  it("blocks ACP turns when ACP dispatch is disabled by policy", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      writeAcpSessionStore(storePath);
      mockConfigWithAcpOverrides(home, storePath, {
        dispatch: { enabled: false },
      });

      const runTurn = vi.fn(async (_params: unknown) => {});
      mockAcpManager({
        runTurn: (params: unknown) => runTurn(params),
      });

      await expect(
        agentCommand({ message: "ping", sessionKey: "agent:codex:acp:test" }, runtime),
      ).rejects.toMatchObject({
        code: "ACP_DISPATCH_DISABLED",
      });
      expect(runTurn).not.toHaveBeenCalled();
      expect(runEmbeddedPiAgentSpy).not.toHaveBeenCalled();
    });
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
});
