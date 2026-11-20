import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { applyLoginAgentRuntime } from "./auth-login-runtime.js";

const model = "openai/gpt-5.5";

describe("applyLoginAgentRuntime", () => {
  it("keeps a runtime the agent already set for that model", () => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: { models: { [model]: { agentRuntime: { id: "codex" } } } } } },
    };
    const login = { agentId: "main", result: { agentRuntimeId: "openclaw" } };
    expect(applyLoginAgentRuntime(cfg, login, model)).toBe(cfg);
  });
});
