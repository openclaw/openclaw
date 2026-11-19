import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { applyLoginAgentRuntime } from "./auth-login-runtime.js";

const login = { agentId: "main", result: { agentRuntimeId: "openclaw" } };
const model = "openai/gpt-5.5";

describe("applyLoginAgentRuntime", () => {
  it("routes the login's starter model through the runtime its provider chose", () => {
    const next = applyLoginAgentRuntime({}, login, model);
    expect(next.agents?.entries?.main?.models?.[model]?.agentRuntime).toEqual({ id: "openclaw" });
  });

  it("keeps a runtime the agent already set for that model", () => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: { models: { [model]: { agentRuntime: { id: "codex" } } } } } },
    };
    expect(applyLoginAgentRuntime(cfg, login, model)).toBe(cfg);
  });

  it("changes nothing when the provider chose no runtime", () => {
    const cfg: OpenClawConfig = {};
    expect(applyLoginAgentRuntime(cfg, { agentId: "main", result: {} }, model)).toBe(cfg);
  });
});
