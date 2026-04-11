import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { agentCliCommand } from "./agent-via-gateway.js";
import type { agentCommand as AgentCommand } from "./agent.js";

const loadConfig = vi.hoisted(() => vi.fn());
const callGateway = vi.hoisted(() => vi.fn());
const agentCommand = vi.hoisted(() => vi.fn());
const listAgentIds = vi.hoisted(() => vi.fn());
const resolveDefaultAgentId = vi.hoisted(() => vi.fn());
const resolveSubagentConfiguredModelSelection = vi.hoisted(() => vi.fn());
const resolveSessionKeyForRequest = vi.hoisted(() => vi.fn());
const isAdminOnlyMethod = vi.hoisted(() => vi.fn());

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

function mockConfig(storePath: string, overrides?: Partial<OpenClawConfig>) {
  loadConfig.mockReturnValue({
    agents: {
      defaults: {
        timeoutSeconds: 600,
        ...overrides?.agents?.defaults,
      },
    },
    session: {
      store: storePath,
      mainKey: "main",
      ...overrides?.session,
    },
    gateway: overrides?.gateway,
  });
}

async function withTempStore(
  fn: (ctx: { dir: string; store: string }) => Promise<void>,
  overrides?: Partial<OpenClawConfig>,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-cli-"));
  const store = path.join(dir, "sessions.json");
  mockConfig(store, overrides);
  try {
    await fn({ dir, store });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function mockGatewaySuccessReply(text = "hello") {
  callGateway.mockResolvedValue({
    runId: "idem-1",
    status: "ok",
    result: {
      payloads: [{ text }],
      meta: { stub: true },
    },
  });
}

function mockLocalAgentReply(text = "local") {
  agentCommand.mockImplementationOnce(async (_opts, rt) => {
    rt?.log?.(text);
    return {
      payloads: [{ text }],
      meta: { durationMs: 1, agentMeta: { sessionId: "s", provider: "p", model: "m" } },
    } as unknown as Awaited<ReturnType<typeof AgentCommand>>;
  });
}

vi.mock("../config/config.js", () => ({ loadConfig }));
vi.mock("../gateway/call.js", () => ({
  callGateway,
  randomIdempotencyKey: () => "idem-1",
}));
vi.mock("./agent.js", () => ({ agentCommand }));
vi.mock("../agents/agent-scope.js", () => ({
  listAgentIds,
  resolveDefaultAgentId,
}));
vi.mock("../agents/model-selection.js", () => ({
  resolveSubagentConfiguredModelSelection,
}));
vi.mock("./agent/session.js", () => ({
  resolveSessionKeyForRequest,
}));
vi.mock("../gateway/method-scopes.js", () => ({
  ADMIN_SCOPE: "admin",
  WRITE_SCOPE: "write",
  isAdminOnlyMethod,
}));

beforeEach(() => {
  vi.clearAllMocks();
  listAgentIds.mockReturnValue(["main", "ops"]);
  resolveDefaultAgentId.mockReturnValue("main");
  resolveSessionKeyForRequest.mockImplementation(
    ({ agentId, to, sessionId }: { agentId?: string; to?: string; sessionId?: string }) => ({
      sessionKey: agentId
        ? `agent:${agentId}:main`
        : to
          ? `whatsapp:${to}`
          : `session:${sessionId ?? "main"}`,
    }),
  );
  resolveSubagentConfiguredModelSelection.mockReturnValue(undefined);
  isAdminOnlyMethod.mockImplementation((method: string) => method === "sessions.patch");
});

describe("agentCliCommand", () => {
  it("uses a timer-safe max gateway timeout when --timeout is 0", async () => {
    await withTempStore(async () => {
      mockGatewaySuccessReply();

      await agentCliCommand({ message: "hi", to: "+1555", timeout: "0" }, runtime);

      expect(callGateway).toHaveBeenCalledTimes(1);
      const request = callGateway.mock.calls[0]?.[0] as { timeoutMs?: number };
      expect(request.timeoutMs).toBe(2_147_000_000);
    });
  });

  it("uses gateway by default", async () => {
    await withTempStore(async () => {
      mockGatewaySuccessReply();

      await agentCliCommand({ message: "hi", to: "+1555" }, runtime);

      expect(callGateway).toHaveBeenCalledTimes(1);
      expect(agentCommand).not.toHaveBeenCalled();
      expect(runtime.log).toHaveBeenCalledWith("hello");
    });
  });

  it("falls back to embedded agent when gateway fails", async () => {
    await withTempStore(async () => {
      callGateway.mockRejectedValue(new Error("gateway not connected"));
      mockLocalAgentReply();

      await agentCliCommand({ message: "hi", to: "+1555" }, runtime);

      expect(callGateway).toHaveBeenCalledTimes(1);
      expect(agentCommand).toHaveBeenCalledTimes(1);
      expect(runtime.log).toHaveBeenCalledWith("local");
    });
  });

  it("skips gateway when --local is set", async () => {
    await withTempStore(async () => {
      mockLocalAgentReply();

      await agentCliCommand(
        {
          message: "hi",
          to: "+1555",
          local: true,
        },
        runtime,
      );

      expect(callGateway).not.toHaveBeenCalled();
      expect(agentCommand).toHaveBeenCalledTimes(1);
      expect(agentCommand.mock.calls[0]?.[0]).toMatchObject({
        cleanupBundleMcpOnRunEnd: true,
      });
      expect(runtime.log).toHaveBeenCalledWith("local");
    });
  });

  it("does not force bundle MCP cleanup on gateway fallback", async () => {
    await withTempStore(async () => {
      callGateway.mockRejectedValue(new Error("gateway not connected"));
      mockLocalAgentReply();

      await agentCliCommand({ message: "hi", to: "+1555" }, runtime);

      expect(agentCommand).toHaveBeenCalledTimes(1);
      expect(agentCommand.mock.calls[0]?.[0]).not.toMatchObject({
        cleanupBundleMcpOnRunEnd: true,
      });
    });
  });

  describe("--spawn", () => {
    function mockSpawnGatewaySuccess(text = "hello") {
      callGateway.mockImplementation(async (req: { method: string }) => {
        if (req.method === "sessions.patch") {
          return undefined;
        }
        return {
          runId: "idem-1",
          status: "ok",
          result: { payloads: [{ text }], meta: { stub: true } },
        };
      });
    }

    it("creates an isolated agent:<id>:subagent:<uuid> session key", async () => {
      await withTempStore(async () => {
        mockSpawnGatewaySuccess();

        await agentCliCommand({ message: "hi", spawn: true }, runtime);

        expect(callGateway).toHaveBeenCalledTimes(2);
        const patchCall = callGateway.mock.calls[0]?.[0] as {
          method: string;
          params: { key: string };
        };
        expect(patchCall.method).toBe("sessions.patch");
        expect(patchCall.params.key).toMatch(
          /^agent:main:subagent:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
      });
    });

    it("pins admin scope on sessions.patch and write scope on the agent call", async () => {
      await withTempStore(async () => {
        mockSpawnGatewaySuccess();

        await agentCliCommand({ message: "hi", spawn: true }, runtime);

        const patchCall = callGateway.mock.calls[0]?.[0] as { scopes: string[] };
        const agentCall = callGateway.mock.calls[1]?.[0] as { scopes: string[] };
        expect(patchCall.scopes).toEqual(["admin"]);
        expect(agentCall.scopes).toEqual(["write"]);
      });
    });

    it("sets lane:'subagent' and leaf-role params on the agent call", async () => {
      await withTempStore(async () => {
        mockSpawnGatewaySuccess();

        await agentCliCommand({ message: "hi", spawn: true }, runtime);

        const patchCall = callGateway.mock.calls[0]?.[0] as {
          params: { spawnDepth: number; subagentRole: string; subagentControlScope: string };
        };
        const agentCall = callGateway.mock.calls[1]?.[0] as { params: { lane: string } };
        expect(patchCall.params.spawnDepth).toBe(1);
        expect(patchCall.params.subagentRole).toBe("leaf");
        expect(patchCall.params.subagentControlScope).toBe("none");
        expect(agentCall.params.lane).toBe("subagent");
      });
    });

    it("refuses to proceed when sessions.patch fails", async () => {
      await withTempStore(async () => {
        callGateway.mockImplementationOnce(async () => {
          throw new Error("patch boom");
        });

        await expect(agentCliCommand({ message: "hi", spawn: true }, runtime)).rejects.toThrow(
          /sessions\.patch failed.*patch boom.*Refusing to run/s,
        );
        expect(callGateway).toHaveBeenCalledTimes(1);
      });
    });

    it("rejects --spawn combined with --local", async () => {
      await withTempStore(async () => {
        await expect(
          agentCliCommand({ message: "hi", spawn: true, local: true }, runtime),
        ).rejects.toThrow(/--spawn cannot be combined with --local/);
        expect(callGateway).not.toHaveBeenCalled();
        expect(agentCommand).not.toHaveBeenCalled();
      });
    });

    it("rejects --spawn combined with --session-id", async () => {
      await withTempStore(async () => {
        await expect(
          agentCliCommand({ message: "hi", spawn: true, sessionId: "resume-me" }, runtime),
        ).rejects.toThrow(/--spawn.*cannot be combined with --session-id/);
        expect(callGateway).not.toHaveBeenCalled();
      });
    });

    it("does not silently fall back to embedded when gateway fails under --spawn", async () => {
      await withTempStore(async () => {
        callGateway.mockImplementation(async (req: { method: string }) => {
          if (req.method === "sessions.patch") {
            return undefined;
          }
          throw new Error("gateway dead");
        });

        await expect(agentCliCommand({ message: "hi", spawn: true }, runtime)).rejects.toThrow(
          /gateway dead/,
        );
        expect(agentCommand).not.toHaveBeenCalled();
      });
    });

    it("warns about orphaned subagent session when agent RPC fails", async () => {
      await withTempStore(async () => {
        callGateway.mockImplementation(async (req: { method: string }) => {
          if (req.method === "sessions.patch") {
            return undefined;
          }
          throw new Error("agent timeout");
        });

        await expect(agentCliCommand({ message: "hi", spawn: true }, runtime)).rejects.toThrow(
          /agent timeout/,
        );
        expect(runtime.error).toHaveBeenCalledWith(
          expect.stringMatching(
            /subagent session agent:main:subagent:[0-9a-f-]{36} may be live or orphaned/,
          ),
        );
      });
    });

    it("falls back to the configured default agent when --agent is not set (no binding inference)", async () => {
      await withTempStore(async () => {
        resolveDefaultAgentId.mockReturnValueOnce("ops");
        mockSpawnGatewaySuccess();

        // --to is supplied but --agent is not. The spawn path uses
        // resolveDefaultAgentId and does NOT consult routing bindings; this
        // matches the pre-existing CLI outbound behavior.
        await agentCliCommand({ message: "hi", spawn: true, to: "+1555" }, runtime);

        const patchCall = callGateway.mock.calls[0]?.[0] as { params: { key: string } };
        expect(patchCall.params.key).toMatch(/^agent:ops:subagent:/);
      });
    });

    it("seeds session model when a subagent-scoped model is configured", async () => {
      await withTempStore(async () => {
        resolveSubagentConfiguredModelSelection.mockReturnValueOnce({
          provider: "openai",
          model: "gpt-5.4",
        });
        mockSpawnGatewaySuccess();

        await agentCliCommand({ message: "hi", spawn: true }, runtime);

        const patchCall = callGateway.mock.calls[0]?.[0] as { params: Record<string, unknown> };
        expect(patchCall.params.model).toEqual({ provider: "openai", model: "gpt-5.4" });
      });
    });

    it("omits model from sessions.patch when no subagent model is configured", async () => {
      await withTempStore(async () => {
        mockSpawnGatewaySuccess();

        await agentCliCommand({ message: "hi", spawn: true }, runtime);

        const patchCall = callGateway.mock.calls[0]?.[0] as { params: Record<string, unknown> };
        expect(patchCall.params).not.toHaveProperty("model");
      });
    });
  });
});
