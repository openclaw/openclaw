import { describe, expect, it } from "vitest";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHeartbeatIntervalMs } from "./heartbeat-config.js";
import { resolveConfiguredHeartbeatPrompt } from "./heartbeat-runner-config.js";
import {
  isHeartbeatEnabledForAgent,
  resolveHeartbeatSummaryForAgent,
} from "./heartbeat-summary.js";

describe("resolveHeartbeatIntervalMs", () => {
  it("reports owner as the default delivery target", () => {
    expect(resolveHeartbeatSummaryForAgent({}).target).toBe("owner");
  });

  it("reports the merged per-agent heartbeat session", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { heartbeat: { session: "telegram:default" } },
        list: [{ id: "main", heartbeat: { session: "telegram:alerts" } }],
      },
    };

    expect(resolveHeartbeatSummaryForAgent(cfg, "main").session).toBe("telegram:alerts");
  });

  it.each([
    {
      label: "global",
      cfg: {
        agents: {
          defaults: {
            heartbeat: { every: "0m", target: "last", session: "telegram:default" },
          },
        },
      },
      session: "telegram:default",
    },
    {
      label: "per-agent",
      cfg: {
        agents: {
          defaults: {
            heartbeat: { every: "30m", target: "last", session: "telegram:default" },
          },
          list: [{ id: "main", heartbeat: { every: "0m", session: "telegram:alerts" } }],
        },
      },
      session: "telegram:alerts",
    },
  ] satisfies Array<{ label: string; cfg: OpenClawConfig; session: string }>)(
    "reports a disabled $label heartbeat as disabled",
    ({ cfg, session }) => {
      expect(resolveHeartbeatSummaryForAgent(cfg, "main")).toMatchObject({
        enabled: false,
        every: "disabled",
        everyMs: null,
        target: "last",
        session,
      });
    },
  );

  it("returns default when unset", () => {
    expect(resolveHeartbeatIntervalMs({})).toBe(30 * 60_000);
  });

  it("returns null when invalid or zero", () => {
    expect(
      resolveHeartbeatIntervalMs({
        agents: { defaults: { heartbeat: { every: "0m" } } },
      }),
    ).toBeNull();
    expect(
      resolveHeartbeatIntervalMs({
        agents: { defaults: { heartbeat: { every: "oops" } } },
      }),
    ).toBeNull();
  });

  it("parses duration strings with minute defaults", () => {
    expect(
      resolveHeartbeatIntervalMs({
        agents: { defaults: { heartbeat: { every: "5m" } } },
      }),
    ).toBe(5 * 60_000);
    expect(
      resolveHeartbeatIntervalMs({
        agents: { defaults: { heartbeat: { every: "5" } } },
      }),
    ).toBe(5 * 60_000);
    expect(
      resolveHeartbeatIntervalMs({
        agents: { defaults: { heartbeat: { every: "2h" } } },
      }),
    ).toBe(2 * 60 * 60_000);
  });

  it("uses explicit heartbeat overrides when provided", () => {
    expect(
      resolveHeartbeatIntervalMs(
        { agents: { defaults: { heartbeat: { every: "30m" } } } },
        undefined,
        { every: "5m" },
      ),
    ).toBe(5 * 60_000);
  });
});

describe("resolveConfiguredHeartbeatPrompt", () => {
  it.each([
    { name: "default prompt", cfg: {} as OpenClawConfig, expected: HEARTBEAT_PROMPT },
    {
      name: "trimmed override prompt",
      cfg: {
        agents: { defaults: { heartbeat: { prompt: "  ping  " } } },
      } as OpenClawConfig,
      expected: "ping",
    },
  ])("uses $name", ({ cfg, expected }) => {
    expect(resolveConfiguredHeartbeatPrompt(cfg)).toBe(expected);
  });
});

describe("isHeartbeatEnabledForAgent", () => {
  it("enables only explicit heartbeat agents when configured", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { heartbeat: { every: "30m" } },
        list: [{ id: "main" }, { id: "ops", heartbeat: { every: "1h" } }],
      },
    };
    expect(isHeartbeatEnabledForAgent(cfg, "main")).toBe(false);
    expect(isHeartbeatEnabledForAgent(cfg, "ops")).toBe(true);
  });

  it("uses global heartbeat defaults for all agents when no explicit heartbeat entries exist", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { heartbeat: { every: "30m" } },
        list: [{ id: "main" }, { id: "ops" }],
      },
    };
    expect(isHeartbeatEnabledForAgent(cfg, "main")).toBe(true);
    expect(isHeartbeatEnabledForAgent(cfg, "ops")).toBe(true);
  });

  it("uses the configured ambient heartbeat owner when one is explicit", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { heartbeat: { agentId: "ops", every: "30m" } },
        list: [{ id: "main" }, { id: "ops" }],
      },
    };
    expect(isHeartbeatEnabledForAgent(cfg, "main")).toBe(false);
    expect(isHeartbeatEnabledForAgent(cfg, "ops")).toBe(true);
  });

  it("falls back to the sole agent when no heartbeat config exists", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main" }],
      },
    };
    expect(isHeartbeatEnabledForAgent(cfg, "main")).toBe(true);
    expect(isHeartbeatEnabledForAgent(cfg, "ops")).toBe(false);
  });
});
