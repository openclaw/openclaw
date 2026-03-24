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
    expect(parsed.fixIt).toContain("tools.sandbox.tools.alsoAllow");
    expect(parsed.fixIt).toContain("tools.sandbox.tools.deny");
  });

  it("shows effective sandbox alsoAllow grants and default-deny removals", async () => {
    mockCfg = {
      agents: {
        defaults: {
          sandbox: { mode: "all", scope: "agent", workspaceAccess: "none" },
        },
        list: [
          {
            id: "tavern",
            tools: {
              sandbox: {
                tools: {
                  alsoAllow: ["message", "tts"],
                },
              },
            },
          },
        ],
      },
      tools: {
        sandbox: {
          tools: {
            allow: ["browser"],
          },
        },
      },
      session: { store: "/tmp/openclaw-test-sessions-{agentId}.json" },
    };

    const logs: string[] = [];
    await sandboxExplainCommand({ json: true, agent: "tavern" }, {
      log: (msg: string) => logs.push(msg),
      error: (msg: string) => logs.push(msg),
      exit: (_code: number) => {},
    } as unknown as Parameters<typeof sandboxExplainCommand>[1]);

    const parsed = JSON.parse(logs.join(""));
    expect(parsed.sandbox.tools.allow).toEqual(
      expect.arrayContaining(["browser", "message", "tts"]),
    );
    expect(parsed.sandbox.tools.deny).not.toContain("browser");
    expect(parsed.sandbox.tools.sources.allow).toEqual({
      source: "agent",
      key: "agents.list[].tools.sandbox.tools.alsoAllow",
    });
  });

  it("uses Discord channel allowFrom fallback in elevated diagnostics", async () => {
    mockCfg = {
      channels: {
        discord: {
          allowFrom: ["123456"],
        },
      },
      tools: {
        elevated: { enabled: true },
      },
      session: { store: "/tmp/openclaw-test-sessions-{agentId}.json" },
    };

    const logs: string[] = [];
    await sandboxExplainCommand({ json: true, session: "agent:main:discord:dm:123456" }, {
      log: (msg: string) => logs.push(msg),
      error: (msg: string) => logs.push(msg),
      exit: (_code: number) => {},
    } as unknown as Parameters<typeof sandboxExplainCommand>[1]);

    const parsed = JSON.parse(logs.join(""));
    expect(parsed.elevated.channel).toBe("discord");
    expect(parsed.elevated.allowedByConfig).toBe(true);
    expect(parsed.elevated.allowFrom.global).toEqual(["123456"]);
  });

  it("uses Discord account-level fallback in elevated diagnostics when session key includes account", async () => {
    mockCfg = {
      channels: {
        discord: {
          accounts: {
            serverx: {
              allowFrom: ["7890"],
            },
          },
          allowFrom: ["123456"],
        },
      },
      tools: {
        elevated: { enabled: true },
      },
      session: { store: "/tmp/openclaw-test-sessions-{agentId}.json" },
    };

    const logs: string[] = [];
    await sandboxExplainCommand(
      { json: true, session: "agent:main:discord:serverx:direct:7890" },
      {
        log: (msg: string) => logs.push(msg),
        error: (msg: string) => logs.push(msg),
        exit: (_code: number) => {},
      } as unknown as Parameters<typeof sandboxExplainCommand>[1],
    );

    const parsed = JSON.parse(logs.join(""));
    expect(parsed.elevated.channel).toBe("discord");
    expect(parsed.elevated.accountId).toBe("serverx");
    expect(parsed.elevated.allowedByConfig).toBe(true);
    expect(parsed.elevated.allowFrom.global).toEqual(["7890"]);
  });
});
