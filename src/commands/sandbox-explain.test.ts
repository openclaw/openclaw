import { describe, expect, it, vi } from "vitest";

const SANDBOX_EXPLAIN_TEST_TIMEOUT_MS = process.platform === "win32" ? 45_000 : 30_000;

let mockCfg: unknown = {};

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: vi.fn().mockImplementation(() => mockCfg),
  };
});

const { sandboxExplainCommand } = await import("./sandbox-explain.js");

describe("sandbox explain command", () => {
  it("prints JSON shape + fix-it keys", { timeout: SANDBOX_EXPLAIN_TEST_TIMEOUT_MS }, async () => {
    mockCfg = {
      agents: {
        defaults: {
          sandbox: { mode: "all", scope: "agent", workspaceAccess: "none" },
        },
      },
      tools: {
        sandbox: { tools: { deny: ["browser"] } },
        elevated: { enabled: true, allowFrom: { whatsapp: ["*"] } },
      },
      session: { store: "/tmp/openclaw-test-sessions-{agentId}.json" },
    };

    const logs: string[] = [];
    await sandboxExplainCommand({ json: true, session: "agent:main:main" }, {
      log: (msg: string) => logs.push(msg),
      error: (msg: string) => logs.push(msg),
      exit: (_code: number) => {},
    } as unknown as Parameters<typeof sandboxExplainCommand>[1]);

    const out = logs.join("");
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty("docsUrl", "https://docs.openclaw.ai/sandbox");
    expect(parsed).toHaveProperty("sandbox.mode", "all");
    expect(parsed).toHaveProperty("sandbox.tools.sources.allow.source");
    expect(Array.isArray(parsed.fixIt)).toBe(true);
    expect(parsed.fixIt).toContain("agents.defaults.sandbox.mode=off");
    expect(parsed.fixIt).toContain("tools.sandbox.tools.deny");
  });

  it(
    "normalizes non-agent-scoped colon keys (e.g. telegram:slash:200)",
    { timeout: SANDBOX_EXPLAIN_TEST_TIMEOUT_MS },
    async () => {
      mockCfg = {
        agents: {
          defaults: {
            sandbox: { mode: "all", scope: "agent", workspaceAccess: "none" },
          },
        },
        tools: {
          elevated: { enabled: true, allowFrom: { telegram: ["200"] } },
        },
        session: { store: "/tmp/openclaw-test-sessions-{agentId}.json" },
      };

      const logs: string[] = [];
      await sandboxExplainCommand({ json: true, session: "telegram:slash:200" }, {
        log: (msg: string) => logs.push(msg),
        error: (msg: string) => logs.push(msg),
        exit: (_code: number) => {},
      } as unknown as Parameters<typeof sandboxExplainCommand>[1]);

      const out = logs.join("");
      const parsed = JSON.parse(out);
      // The session key should have been normalized to agent-scoped format.
      expect(parsed.sessionKey).toBe("agent:main:telegram:slash:200");
      // Core bug: channel must be inferred correctly and config must allow it.
      expect(parsed.elevated.channel).toBe("telegram");
      expect(parsed.elevated.allowedByConfig).toBe(true);
    },
  );

  it(
    "preserves already agent-scoped colon keys unchanged",
    { timeout: SANDBOX_EXPLAIN_TEST_TIMEOUT_MS },
    async () => {
      mockCfg = {
        agents: {
          defaults: {
            sandbox: { mode: "all", scope: "agent", workspaceAccess: "none" },
          },
        },
        tools: {
          elevated: { enabled: true },
        },
        session: { store: "/tmp/openclaw-test-sessions-{agentId}.json" },
      };

      const logs: string[] = [];
      await sandboxExplainCommand({ json: true, session: "agent:main:telegram:slash:200" }, {
        log: (msg: string) => logs.push(msg),
        error: (msg: string) => logs.push(msg),
        exit: (_code: number) => {},
      } as unknown as Parameters<typeof sandboxExplainCommand>[1]);

      const out = logs.join("");
      const parsed = JSON.parse(out);
      // Already agent-scoped — should pass through unchanged.
      expect(parsed.sessionKey).toBe("agent:main:telegram:slash:200");
    },
  );
});
