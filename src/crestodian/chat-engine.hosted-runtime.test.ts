import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { CrestodianChatEngine } from "./chat-engine.js";
import type { CrestodianOverview } from "./overview.js";

const mocks = vi.hoisted(() => ({
  defaultExit: vi.fn(),
  runModelSetup: vi.fn(async (params: { runtime: RuntimeEnv }) => {
    params.runtime.exit(1);
  }),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: mocks.defaultExit,
  },
}));

vi.mock("./model-setup.js", () => ({
  runCrestodianModelSetup: mocks.runModelSetup,
}));

const overview: CrestodianOverview = {
  defaultAgentId: "main",
  agents: [{ id: "main", isDefault: true }],
  config: {
    path: "/tmp/openclaw.json",
    exists: true,
    valid: true,
    issues: [],
    hash: null,
  },
  tools: {
    codex: { command: "codex", found: false, error: "not found" },
    claude: { command: "claude", found: false, error: "not found" },
    gemini: { command: "gemini", found: false, error: "not found" },
    apiKeys: { openai: false, anthropic: false },
  },
  gateway: {
    url: "ws://127.0.0.1:18789",
    source: "local loopback",
    reachable: true,
  },
  references: {
    docsUrl: "https://docs.openclaw.ai",
    sourceUrl: "https://github.com/openclaw/openclaw",
  },
};

describe("hosted model setup runtime", () => {
  it("turns runtime exits into chat errors instead of terminating the gateway", async () => {
    const engine = new CrestodianChatEngine({
      surface: "gateway",
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: async () => overview },
    });

    const reply = await engine.handle("configure model provider");

    expect(reply.text).toContain("hosted wizard exited with code 1");
    expect(mocks.runModelSetup).toHaveBeenCalledOnce();
    expect(mocks.defaultExit).not.toHaveBeenCalled();
  });
});
