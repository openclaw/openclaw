import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHeartbeatSessionTarget } from "./heartbeat-session-target.js";

const cfg: OpenClawConfig = {
  agents: { entries: { ops: {} } },
  session: { mainKey: "work", dmScope: "main" },
  channels: { telegram: { allowFrom: ["123"] } },
};

it.each([
  [undefined, undefined, "agent:ops:work", false],
  [" agent:ops:topic ", undefined, "agent:ops:topic", false],
  ["global", undefined, "agent:ops:work", false],
  ["agent:ops:main", undefined, "agent:ops:work", false],
  ["agent:ops:subagent:child", undefined, "agent:ops:work", false],
  ["agent:other:topic", undefined, "agent:ops:work", false],
  ["agent:ops:topic", "agent:ops:subagent:child", "agent:ops:work", true],
  ["agent:ops:topic", "agent:other:topic", "agent:ops:topic", false],
  ["agent:ops:topic", "agent:ops:main", "agent:ops:work", false],
  ["agent:ops:topic", "agent:ops:other", "agent:ops:other", false],
  ["agent:ops:topic", "agent:ops:telegram:default:direct:123", "agent:ops:work", false],
] as const)(
  "selects configured %s / forced %s without crossing session ownership",
  (configured, forced, sessionKey, suppressOriginatingContext) => {
    expect(
      resolveHeartbeatSessionTarget(cfg, "ops", "/synthetic/sessions", configured, forced),
    ).toEqual({
      sessionKey,
      storePath: "/synthetic/sessions",
      suppressOriginatingContext,
    });
  },
);

it("keeps live global scope literal even when a forced subagent is supplied", () => {
  expect(
    resolveHeartbeatSessionTarget(
      { ...cfg, session: { ...cfg.session, scope: "global" } },
      "ops",
      "/synthetic/sessions",
      "agent:ops:topic",
      "agent:ops:subagent:child",
    ),
  ).toEqual({
    sessionKey: "global",
    storePath: "/synthetic/sessions",
    suppressOriginatingContext: false,
  });
});
