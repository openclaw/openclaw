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
    "reports private-mode-forced sandboxing in JSON output when sandboxMode is all",
    { timeout: SANDBOX_EXPLAIN_TEST_TIMEOUT_MS },
    async () => {
      mockCfg = {
        privateMode: {
          enabled: true,
          execution: {
            sandboxMode: "all",
            blockHostExec: true,
          },
        },
        agents: {
          defaults: {
            sandbox: { mode: "off", scope: "session", workspaceAccess: "none" },
          },
          list: [{ id: "main" }],
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

      const parsed = JSON.parse(logs.join(""));
      expect(parsed.sandbox.mode).toBe("all");
      expect(parsed.sandbox.sessionIsSandboxed).toBe(true);
      expect(parsed.sandbox.forcedByPrivateMode).toBe(true);
      expect(parsed.fixIt).toContain("privateMode.execution.sandboxMode");
      expect(parsed.fixIt).toContain("privateMode.execution.blockHostExec");
      expect(parsed.fixIt).not.toContain("agents.defaults.sandbox.mode=off");
    },
  );

  it(
    "reports private-mode-forced sandboxing when blockHostExec alone is enabled",
    { timeout: SANDBOX_EXPLAIN_TEST_TIMEOUT_MS },
    async () => {
      mockCfg = {
        privateMode: {
          enabled: true,
          execution: {
            blockHostExec: true,
          },
        },
        agents: {
          defaults: {
            sandbox: { mode: "off", scope: "session", workspaceAccess: "none" },
          },
          list: [{ id: "main" }],
        },
        tools: {
          sandbox: { tools: { deny: ["browser"] } },
        },
        session: { store: "/tmp/openclaw-test-sessions-{agentId}.json" },
      };

      const logs: string[] = [];
      await sandboxExplainCommand({ json: true, session: "agent:main:main" }, {
        log: (msg: string) => logs.push(msg),
        error: (msg: string) => logs.push(msg),
        exit: (_code: number) => {},
      } as unknown as Parameters<typeof sandboxExplainCommand>[1]);

      const parsed = JSON.parse(logs.join(""));
      expect(parsed.sandbox.mode).toBe("all");
      expect(parsed.sandbox.sessionIsSandboxed).toBe(true);
      expect(parsed.sandbox.forcedByPrivateMode).toBe(true);
    },
  );
});
