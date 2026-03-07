import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { isHeartbeatEnabledForAgent } from "./heartbeat-runner.js";

describe("heartbeat agent routing via agents.defaults.heartbeat.agentId", () => {
  it("routes heartbeat to the default agent when agentId is not set", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          heartbeat: { every: "30m" },
        },
        list: [{ id: "main", default: true }, { id: "ops" }],
      },
    };

    expect(isHeartbeatEnabledForAgent(cfg, "main")).toBe(true);
    expect(isHeartbeatEnabledForAgent(cfg, "ops")).toBe(false);
  });

  it("routes heartbeat to the specified agentId", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          heartbeat: { every: "30m", agentId: "ops" },
        },
        list: [{ id: "main", default: true }, { id: "ops" }],
      },
    };

    expect(isHeartbeatEnabledForAgent(cfg, "main")).toBe(false);
    expect(isHeartbeatEnabledForAgent(cfg, "ops")).toBe(true);
  });

  it("per-agent heartbeat blocks take precedence over agentId", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          heartbeat: { every: "30m", agentId: "ops" },
        },
        list: [
          { id: "main", default: true },
          { id: "ops" },
          { id: "monitor", heartbeat: { every: "1h" } },
        ],
      },
    };

    // agentId is ignored when per-agent heartbeat blocks exist
    expect(isHeartbeatEnabledForAgent(cfg, "main")).toBe(false);
    expect(isHeartbeatEnabledForAgent(cfg, "ops")).toBe(false);
    expect(isHeartbeatEnabledForAgent(cfg, "monitor")).toBe(true);
  });

  it("works with no agents list (single agent)", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          heartbeat: { every: "30m", agentId: "ops" },
        },
      },
    };

    expect(isHeartbeatEnabledForAgent(cfg, "ops")).toBe(true);
    expect(isHeartbeatEnabledForAgent(cfg, "main")).toBe(false);
  });
});
