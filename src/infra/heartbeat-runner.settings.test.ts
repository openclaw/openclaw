import { describe, expect, it } from "vitest";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHeartbeatIntervalMs } from "./heartbeat-config.js";
import { resolveConfiguredHeartbeatPrompt } from "./heartbeat-runner-config.js";
import { resolveHeartbeatSummaryForAgent } from "./heartbeat-summary.js";

describe("heartbeat settings", () => {
  it.each([
    { name: "default target", cfg: {}, agentId: undefined, expected: { target: "owner" } },
    {
      name: "per-agent session",
      cfg: {
        agents: {
          defaults: { heartbeat: { session: "telegram:default" } },
          entries: { main: { heartbeat: { session: "telegram:alerts" } } },
        },
      },
      agentId: "main",
      expected: { session: "telegram:alerts" },
    },
    ...[false, true].map((perAgent) => ({
      name: perAgent ? "disabled per-agent" : "disabled global",
      cfg: {
        agents: {
          defaults: {
            heartbeat: {
              every: perAgent ? "30m" : "0m",
              target: "last",
              session: "telegram:default",
            },
          },
          ...(perAgent
            ? { entries: { main: { heartbeat: { every: "0m", session: "telegram:alerts" } } } }
            : {}),
        },
      },
      agentId: "main",
      expected: {
        enabled: false,
        every: "disabled",
        everyMs: null,
        target: "last",
        session: perAgent ? "telegram:alerts" : "telegram:default",
      },
    })),
  ] satisfies Array<{
    name: string;
    cfg: OpenClawConfig;
    agentId: string | undefined;
    expected: Partial<ReturnType<typeof resolveHeartbeatSummaryForAgent>>;
  }>)("reports $name", ({ cfg, agentId, expected }) => {
    expect(resolveHeartbeatSummaryForAgent(cfg, agentId)).toMatchObject(expected);
  });

  it("resolves default, configured, invalid, and overridden intervals", () => {
    const cases = [
      { every: undefined, expected: 30 * 60_000 },
      { every: "0m", expected: null },
      { every: "oops", expected: null },
      { every: "5m", expected: 5 * 60_000 },
      { every: "5", expected: 5 * 60_000 },
      { every: "2h", expected: 2 * 60 * 60_000 },
      { every: "30m", override: "5m", expected: 5 * 60_000 },
    ];
    for (const { every, override, expected } of cases) {
      const cfg = every === undefined ? {} : { agents: { defaults: { heartbeat: { every } } } };
      expect(
        resolveHeartbeatIntervalMs(cfg, undefined, override ? { every: override } : undefined),
      ).toBe(expected);
    }
  });

  it.each([
    { name: "default prompt", cfg: {}, expected: HEARTBEAT_PROMPT },
    {
      name: "trimmed override prompt",
      cfg: { agents: { defaults: { heartbeat: { prompt: "  ping  " } } } },
      expected: "ping",
    },
  ] satisfies Array<{ name: string; cfg: OpenClawConfig; expected: string }>)(
    "uses $name",
    ({ cfg, expected }) => {
      expect(resolveConfiguredHeartbeatPrompt(cfg)).toBe(expected);
    },
  );
});
