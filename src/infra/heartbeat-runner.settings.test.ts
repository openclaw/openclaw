import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHeartbeatIntervalMs } from "./heartbeat-config.js";
import { resolveConfiguredHeartbeatPrompt } from "./heartbeat-runner-config.js";
import { resolveHeartbeatSummaryForAgent } from "./heartbeat-summary.js";
import {
  inferHeartbeatWakeSourceFromReason,
  resolveHeartbeatWakePayloadFlags,
} from "./heartbeat-wake-policy.js";

type Heartbeat = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["heartbeat"];
const config = (heartbeat: Heartbeat): OpenClawConfig => ({ agents: { defaults: { heartbeat } } });

it.each([
  { name: "default target", cfg: {}, agentId: undefined, expected: { target: "owner" } },
  {
    name: "per-agent session",
    cfg: {
      agents: {
        ...config({ session: "telegram:default" }).agents,
        entries: { main: { heartbeat: { session: "telegram:alerts" } } },
      },
    },
    agentId: "main",
    expected: { session: "telegram:alerts" },
  },
  {
    name: "disabled global",
    cfg: config({ every: "0m", target: "last", session: "telegram:default" }),
    agentId: "main",
    expected: {
      enabled: false,
      every: "disabled",
      everyMs: null,
      target: "last",
      session: "telegram:default",
    },
  },
])("reports $name", ({ cfg, agentId, expected }) => {
  expect(resolveHeartbeatSummaryForAgent(cfg, agentId)).toMatchObject(expected);
});

it("resolves default, configured, invalid, and overridden intervals", () => {
  for (const [every, expected, override] of [
    [undefined, 30 * 60_000],
    ["0m", null],
    ["oops", null],
    ["5m", 5 * 60_000],
    ["5", 5 * 60_000],
    ["2h", 2 * 60 * 60_000],
    ["30m", 5 * 60_000, "5m"],
  ] as const) {
    expect(
      resolveHeartbeatIntervalMs(
        every === undefined ? {} : config({ every }),
        undefined,
        override ? { every: override } : undefined,
      ),
    ).toBe(expected);
  }
});

it("uses a trimmed override prompt", () => {
  expect(resolveConfiguredHeartbeatPrompt(config({ prompt: "  ping  " }))).toBe("ping");
});

it("infers the session-state source and marks the wake as payload-bearing", () => {
  const reason = "session-state:agent:main:child";
  expect(inferHeartbeatWakeSourceFromReason(reason)).toBe("session-state");
  expect(resolveHeartbeatWakePayloadFlags({ reason })).toMatchObject({ isWakePayload: true });
  expect(resolveHeartbeatWakePayloadFlags({ source: "session-state" })).toMatchObject({
    isWakePayload: true,
  });
});
