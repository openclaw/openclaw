/**
 * Exec Notify Wake Hook Handler
 *
 * When a background exec completes, the gateway enqueues a system event and
 * calls requestHeartbeatNow(). But when heartbeats are disabled (every: "0"),
 * no wake handler is registered and the system event is never consumed.
 *
 * This hook listens to exec:completed and exec:failed internal hook events
 * (fired directly from maybeNotifyOnExit in bash-tools.exec-runtime) and
 * calls agentCommand() to trigger a new agent turn. The system event is
 * already in the queue and will be drained into the prompt automatically.
 *
 * Uses the subagent lane to avoid interfering with any active main-lane turn.
 */

import { AGENT_LANE_SUBAGENT } from "../../../agents/lanes.js";
import { agentCommand } from "../../../commands/agent.js";
import { loadConfig } from "../../../config/config.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveHookConfig } from "../../config.js";
import type { HookHandler } from "../../hooks.js";

const log = createSubsystemLogger("hooks/exec-notify-wake");

const handler: HookHandler = async (event) => {
  if (event.type !== "exec") {
    return;
  }

  const cfg = loadConfig();
  const hookCfg = resolveHookConfig(cfg, "exec-notify-wake");
  if (hookCfg?.enabled === false) {
    return;
  }

  const sessionKey = event.sessionKey;
  if (!sessionKey) {
    log.info("exec-notify-wake: no sessionKey — skipping");
    return;
  }

  const text = (event.context as { text?: string }).text ?? "";
  log.info(`exec-notify-wake: exec ${event.action} for ${sessionKey} — triggering agent turn`);

  try {
    await agentCommand({
      message: text || "[System: background exec completed — check session for details]",
      sessionKey,
      lane: String(AGENT_LANE_SUBAGENT),
      senderIsOwner: false,
      deliver: true,
    });
    log.info(`exec-notify-wake: agent turn complete for ${sessionKey}`);
  } catch (err) {
    log.warn(
      `exec-notify-wake: agentCommand failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};

export default handler;
