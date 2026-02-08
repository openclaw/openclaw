import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveAgentTimeoutMs,
  resolveSubagentAnnounceDeliveryTimeoutMs,
  resolveSubagentAnnounceMaxAgeMs,
} from "./timeout.js";

describe("resolveAgentTimeoutMs", () => {
  it("uses a timer-safe sentinel for no-timeout overrides", () => {
    expect(resolveAgentTimeoutMs({ overrideSeconds: 0 })).toBe(2_147_000_000);
    expect(resolveAgentTimeoutMs({ overrideMs: 0 })).toBe(2_147_000_000);
  });

  it("clamps very large timeout overrides to timer-safe values", () => {
    expect(resolveAgentTimeoutMs({ overrideSeconds: 9_999_999 })).toBe(2_147_000_000);
    expect(resolveAgentTimeoutMs({ overrideMs: 9_999_999_999 })).toBe(2_147_000_000);
  });

  it("resolves subagent announce max age from config with sane defaults", () => {
    expect(resolveSubagentAnnounceMaxAgeMs()).toBe(10 * 60 * 1000);
    expect(
      resolveSubagentAnnounceMaxAgeMs({
        agents: { defaults: { subagents: { announceMaxAgeMs: 30_000 } } },
      } as OpenClawConfig),
    ).toBe(30_000);
    expect(
      resolveSubagentAnnounceMaxAgeMs({
        agents: { defaults: { subagents: { announceMaxAgeMs: -1 } } },
      } as OpenClawConfig),
    ).toBe(10 * 60 * 1000);
  });
});

describe("resolveSubagentAnnounceDeliveryTimeoutMs", () => {
  it("defaults to 60s when config is unset", () => {
    expect(resolveSubagentAnnounceDeliveryTimeoutMs(undefined)).toBe(60_000);
  });

  it("reads configured value", () => {
    expect(
      resolveSubagentAnnounceDeliveryTimeoutMs({
        agents: { defaults: { subagents: { announceDeliveryTimeoutMs: 300_000 } } },
      }),
    ).toBe(300_000);
  });

  it("clamps invalid values to timer-safe bounds", () => {
    expect(
      resolveSubagentAnnounceDeliveryTimeoutMs({
        agents: { defaults: { subagents: { announceDeliveryTimeoutMs: -10 } } },
      }),
    ).toBe(1);
    expect(
      resolveSubagentAnnounceDeliveryTimeoutMs({
        agents: { defaults: { subagents: { announceDeliveryTimeoutMs: 9_999_999_999 } } },
      }),
    ).toBe(2_147_000_000);
  });
});
