import { vi } from "vitest";
import { drainFormattedSystemEvents } from "../auto-reply/reply/session-system-events.js";
import { getReplySystemEventContext } from "../auto-reply/reply/system-event-session-key.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions/main-session.js";
import type { HeartbeatConfig } from "./heartbeat-config.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  type HeartbeatReplySpy,
  heartbeatTestConfig,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";

export type HeartbeatRoutingFixture = ReturnType<typeof routingFixture>;

export function createLastTargetConfig(params: {
  tmpDir: string;
  storePath: string;
  isolatedSession?: boolean;
  heartbeat?: HeartbeatConfig;
}) {
  const cfg = heartbeatTestConfig(params.tmpDir, "last", "telegram", params.storePath);
  Object.assign(
    cfg.agents!.defaults!.heartbeat!,
    params.isolatedSession ? { isolatedSession: true } : {},
    params.heartbeat,
  );
  return cfg;
}

export function withRouting(
  fn: (fixture: HeartbeatRoutingFixture) => Promise<void>,
  isolatedSession = true,
  heartbeat?: HeartbeatConfig,
) {
  return withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) =>
    fn(routingFixture(tmpDir, storePath, replySpy, isolatedSession, heartbeat)),
  );
}

function routingFixture(
  tmpDir: string,
  storePath: string,
  replySpy: HeartbeatReplySpy,
  isolatedSession: boolean,
  heartbeat?: HeartbeatConfig,
) {
  const cfg = createLastTargetConfig({ tmpDir, storePath, isolatedSession, heartbeat });
  const baseKey = resolveMainSessionKey(cfg);
  const isolatedKey = `${baseKey}:heartbeat`;
  const sendTelegram = vi
    .fn()
    .mockResolvedValue({ messageId: "delivered", chatId: "-100155462274" });
  const run = (opts: Omit<Parameters<typeof runHeartbeatOnce>[0], "cfg"> = {}) =>
    runHeartbeatOnce({
      cfg,
      agentId: "main",
      ...opts,
      deps: { getReplyFromConfig: replySpy, telegram: sendTelegram, ...opts.deps },
    });
  return { cfg, storePath, replySpy, baseKey, isolatedKey, sendTelegram, run };
}

export function formatQueuedEvents(
  cfg: OpenClawConfig,
  ctx: Parameters<HeartbeatReplySpy>[0],
  options: Parameters<HeartbeatReplySpy>[1],
) {
  const event = getReplySystemEventContext(options);
  const sessionKey = event?.sessionKey ?? ctx.SessionKey;
  if (!sessionKey) {
    throw new Error("Expected the selected event queue");
  }
  return drainFormattedSystemEvents({
    cfg,
    agentId: "main",
    sessionKey,
    isMainSession: false,
    isNewSession: false,
    events: event?.events ?? [],
  });
}
