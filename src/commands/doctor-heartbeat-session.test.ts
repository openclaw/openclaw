import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveLegacyHeartbeatSessionKey } from "./doctor-heartbeat-session.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createFixture() {
  const root = tempDirs.make("openclaw-doctor-heartbeat-session-");
  const env = {
    HOME: path.join(root, "home"),
    OPENCLAW_HOME: path.join(root, "home", ".openclaw"),
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    XDG_CONFIG_HOME: path.join(root, "xdg", "config"),
    XDG_CACHE_HOME: path.join(root, "xdg", "cache"),
    XDG_DATA_HOME: path.join(root, "xdg", "data"),
    XDG_STATE_HOME: path.join(root, "xdg", "state"),
    XDG_RUNTIME_DIR: path.join(root, "xdg", "runtime"),
  };
  const cfg: OpenClawConfig = {
    agents: { entries: { ops: {} } },
    session: {
      mainKey: "work",
      dmScope: "main",
      store: path.join(root, "stores", "agents", "{agentId}", "sessions", "sessions.json"),
    },
    channels: { telegram: { allowFrom: ["123"] } },
  };
  return {
    cfg,
    env,
    storePath: path.join(root, "stores", "agents", "ops", "sessions", "sessions.json"),
  };
}

it.each([
  [undefined, undefined, "agent:ops:work"],
  [" agent:ops:topic ", undefined, "agent:ops:topic"],
  ["global", undefined, "agent:ops:work"],
  ["agent:ops:main", undefined, "agent:ops:work"],
  ["agent:ops:subagent:child", undefined, "agent:ops:work"],
  ["agent:other:topic", undefined, "agent:ops:work"],
  ["agent:ops:topic", "agent:ops:subagent:child", "agent:ops:work"],
  ["agent:ops:topic", "agent:other:topic", "agent:ops:topic"],
  ["agent:ops:topic", "agent:ops:main", "agent:ops:work"],
  ["agent:ops:topic", "agent:ops:other", "agent:ops:other"],
  ["agent:ops:topic", "agent:ops:telegram:default:direct:123", "agent:ops:work"],
] as const)(
  "selects configured %s / forced %s without crossing session ownership",
  (configured, forced, sessionKey) => {
    const { cfg, env, storePath } = createFixture();
    expect(
      resolveLegacyHeartbeatSessionKey(cfg, "ops", { session: configured }, forced, env),
    ).toEqual({
      sessionKey,
      storePath,
    });
  },
);

it("keeps Doctor-owned global scope literal even when a forced subagent is supplied", () => {
  const { cfg, env, storePath } = createFixture();
  expect(
    resolveLegacyHeartbeatSessionKey(
      { ...cfg, session: { ...cfg.session, scope: "global" } },
      "ops",
      { session: "agent:ops:topic" },
      "agent:ops:subagent:child",
      env,
    ),
  ).toEqual({
    sessionKey: "global",
    storePath,
  });
});
