import fs from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookHandler } from "../../hooks.js";

const log = createSubsystemLogger("auto-wake");

const WAKE_DELAY_MS = 20_000;
const DEDUP_WINDOW_MS = 120_000;
const WAKE_MESSAGE =
  "Gateway just restarted. Run your hydration checklist, then report status briefly.";

let wakeScheduled = false;

/**
 * After gateway restart, sends a single message to the main webchat session
 * so the assistant speaks first — no user input required.
 *
 * Subscribes to both `gateway:startup` and `agent:bootstrap` because the
 * startup event often fires before hooks finish loading. The handler triggers
 * on whichever event arrives first, with a file-stamp dedup to prevent
 * double-fire within a 2-minute window.
 */
const autoWakeHook: HookHandler = async (event) => {
  if (wakeScheduled) {
    return;
  }

  const cfg = event.context?.cfg as Record<string, unknown> | undefined;
  const gateway = cfg?.gateway as Record<string, unknown> | undefined;
  const auth = gateway?.auth as Record<string, unknown> | undefined;
  const token = auth?.token as string | undefined;
  const port = (gateway?.port as number) || 18789;

  if (!token) {
    log.debug("no gateway auth token in config, skipping");
    return;
  }

  // Set flag after token check so a retry via the fallback event is possible
  wakeScheduled = true;

  const stateDir = process.env.OPENCLAW_STATE_DIR
    || path.join(process.env.HOME || ".", ".openclaw");
  const stampPath = path.join(stateDir, ".auto-wake-stamp");

  try {
    const stamp = await fs.readFile(stampPath, "utf-8");
    const lastFire = parseInt(stamp, 10);
    if (Date.now() - lastFire < DEDUP_WINDOW_MS) {
      log.debug("skipping — fired within last 2 min");
      return;
    }
  } catch {
    // No stamp file yet — first fire
  }

  log.info(`assistant will speak in ${WAKE_DELAY_MS / 1000}s`);

  setTimeout(async () => {
    try {
      const res = await fetch(`http://localhost:${String(port)}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "x-openclaw-session-key": "agent:main:main",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: WAKE_MESSAGE }],
        }),
      });

      if (res.ok) {
        log.info("assistant responded — wake complete");
      } else {
        log.warn(`HTTP ${String(res.status)}: ${await res.text().catch(() => "")}`);
      }

      // Write stamp after the request, not before — prevents dedup
      // from blocking retries if the process dies during the delay
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(stampPath, String(Date.now()), "utf-8");
    } catch (err) {
      log.warn(`failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, WAKE_DELAY_MS);
};

export default autoWakeHook;
