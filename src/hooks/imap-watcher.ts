/**
 * IMAP Watcher Service
 *
 * Poll-based email watcher using himalaya CLI. Periodically lists unseen
 * envelopes, fetches new messages, and delivers them to the gateway hooks
 * endpoint. Runs in-process (no child process) alongside the gateway.
 */

import { hasBinary } from "../agents/skills.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { listEnvelopes, markEnvelopeSeen, readMessage } from "./imap-himalaya.js";
import { type ImapHookRuntimeConfig, resolveImapHookRuntimeConfig } from "./imap.js";

const log = createSubsystemLogger("imap-watcher");

/**
 * Maximum number of envelope IDs to keep in the seen set before pruning.
 * Prevents unbounded memory growth on high-volume mailboxes.
 */
const MAX_SEEN_IDS = 2000;
const ENVELOPE_PAGE_SIZE = 50;

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let shuttingDown = false;
let currentConfig: ImapHookRuntimeConfig | null = null;
let seenIds = new Set<string>();

function isHimalayaAvailable(): boolean {
  return hasBinary("himalaya");
}

export type ImapWatcherStartResult = {
  started: boolean;
  reason?: string;
};

/**
 * Start the IMAP watcher service.
 * Called by the gateway if hooks.imap is configured.
 */
export async function startImapWatcher(
  cfg: OpenClawConfig,
  overrides?: import("./imap.js").ImapHookOverrides,
): Promise<ImapWatcherStartResult> {
  log.debug("startImapWatcher called");

  if (!cfg.hooks?.enabled) {
    log.debug("hooks not enabled, skipping start");
    return { started: false, reason: "hooks not enabled" };
  }

  if (!cfg.hooks?.imap?.account) {
    log.debug("no imap account configured, skipping start");
    return { started: false, reason: "no imap account configured" };
  }

  log.debug(`checking himalaya availability...`);
  if (!isHimalayaAvailable()) {
    log.debug("himalaya binary not found");
    return { started: false, reason: "himalaya binary not found" };
  }
  log.debug("himalaya binary found");

  log.debug(`resolving imap config for account: ${cfg.hooks.imap.account}`);
  const resolved = resolveImapHookRuntimeConfig(cfg, overrides ?? {});
  if (!resolved.ok) {
    log.debug(`config resolution failed: ${resolved.error}`);
    return { started: false, reason: resolved.error };
  }

  const runtimeConfig = resolved.value;
  log.debug(`config resolved successfully:`);
  log.debug(`  - account: ${runtimeConfig.account}`);
  log.debug(`  - folder: ${runtimeConfig.folder}`);
  log.debug(`  - pollIntervalSeconds: ${runtimeConfig.pollIntervalSeconds}`);
  log.debug(`  - includeBody: ${runtimeConfig.includeBody}`);
  log.debug(`  - maxBytes: ${runtimeConfig.maxBytes}`);
  log.debug(`  - markSeen: ${runtimeConfig.markSeen}`);
  log.debug(`  - query: ${runtimeConfig.query}`);
  log.debug(`  - himalayaConfig: ${runtimeConfig.himalayaConfig || "(default)"}`);
  log.debug(`  - hookUrl: ${runtimeConfig.hookUrl}`);

  currentConfig = runtimeConfig;
  shuttingDown = false;
  seenIds = new Set();

  // Schedule the first poll immediately.
  log.debug("scheduling first poll immediately");
  schedulePoll(runtimeConfig, 0);

  log.info(
    `imap watcher started for ${runtimeConfig.account} (poll every ${runtimeConfig.pollIntervalSeconds}s)`,
  );

  return { started: true };
}

/**
 * Stop the IMAP watcher service.
 */
export async function stopImapWatcher(): Promise<void> {
  log.debug("stopImapWatcher called");
  shuttingDown = true;

  if (pollTimer) {
    log.debug("clearing poll timer");
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  currentConfig = null;
  log.info("imap watcher stopped");
}

/**
 * Check if the IMAP watcher is running.
 */
export function isImapWatcherRunning(): boolean {
  const running = currentConfig !== null && !shuttingDown;
  log.debug(
    `isImapWatcherRunning: ${running} (currentConfig=${!!currentConfig}, shuttingDown=${shuttingDown})`,
  );
  return running;
}

// -- internal --

function schedulePoll(cfg: ImapHookRuntimeConfig, delayMs: number) {
  if (shuttingDown) {
    log.debug("schedulePoll: shutting down, not scheduling");
    return;
  }
  log.debug(`schedulePoll: scheduling next poll in ${delayMs}ms`);
  pollTimer = setTimeout(() => {
    void runPollCycle(cfg);
  }, delayMs);
}

async function runPollCycle(cfg: ImapHookRuntimeConfig): Promise<void> {
  log.debug("runPollCycle started");

  if (shuttingDown || !currentConfig) {
    log.debug("shuttingDown or no currentConfig, aborting poll cycle");
    return;
  }

  try {
    log.debug(
      `listing envelopes: account=${cfg.account}, folder=${cfg.folder}, query=${cfg.query}, pageSize=${ENVELOPE_PAGE_SIZE}`,
    );
    const envelopes = await listEnvelopes({
      account: cfg.account,
      folder: cfg.folder,
      query: cfg.query,
      pageSize: ENVELOPE_PAGE_SIZE,
      config: cfg.himalayaConfig,
    });

    log.debug(`retrieved ${envelopes.length} envelopes from himalaya`);
    if (envelopes.length > 0) {
      log.debug(
        `first envelope: id=${envelopes[0].id}, subject="${envelopes[0].subject}", from="${envelopes[0].from}"`,
      );
    }

    const newEnvelopes = envelopes.filter((e) => e.id && !seenIds.has(e.id));
    log.debug(`found ${newEnvelopes.length} new envelopes (not in seenIds set)`);

    for (const envelope of newEnvelopes) {
      if (shuttingDown) {
        log.debug("shutting down, breaking out of envelope processing loop");
        break;
      }

      log.debug(
        `processing envelope ${envelope.id}: "${envelope.subject}" from "${envelope.from}"`,
      );
      try {
        await processEnvelope(cfg, envelope);
        seenIds.add(envelope.id);
        log.debug(`envelope ${envelope.id} processed and added to seenIds`);
      } catch (err) {
        log.error(`failed to process envelope ${envelope.id}: ${String(err)}`);
      }
    }

    pruneSeenIds();
  } catch (err) {
    log.error(`poll cycle failed: ${String(err)}`);
  }

  // Schedule next poll.
  log.debug(`scheduling next poll in ${cfg.pollIntervalSeconds}s`);
  schedulePoll(cfg, cfg.pollIntervalSeconds * 1000);
}

async function processEnvelope(
  cfg: ImapHookRuntimeConfig,
  envelope: { id: string; from: string; subject: string; date: string },
): Promise<void> {
  log.debug(`processEnvelope: id=${envelope.id}, includeBody=${cfg.includeBody}`);
  let body = "";
  let snippet = "";

  if (cfg.includeBody) {
    log.debug(`reading message body for ${envelope.id}`);
    try {
      // Read without marking seen (we'll mark explicitly if markSeen is true).
      const message = await readMessage({
        account: cfg.account,
        id: envelope.id,
        folder: cfg.folder,
        config: cfg.himalayaConfig,
        preview: true,
      });
      const originalBodyLength = message.body.length;
      body = truncateBody(message.body, cfg.maxBytes);
      snippet = message.body.slice(0, 200);
      log.debug(
        `message ${envelope.id} read: original=${originalBodyLength} chars, truncated to ${body.length} chars (maxBytes=${cfg.maxBytes})`,
      );
    } catch (err) {
      log.warn(`failed to read message ${envelope.id}: ${String(err)}`);
    }
  } else {
    log.debug(`skipping body read (includeBody=false)`);
  }

  const payload = {
    messages: [
      {
        id: envelope.id,
        from: envelope.from,
        subject: envelope.subject,
        date: envelope.date,
        snippet,
        body,
      },
    ],
  };

  log.debug(`delivering payload to hook: ${cfg.hookUrl}`);
  await deliverToHook(cfg, payload);

  if (cfg.markSeen) {
    log.debug(`marking envelope ${envelope.id} as seen`);
    try {
      await markEnvelopeSeen({
        account: cfg.account,
        id: envelope.id,
        folder: cfg.folder,
        config: cfg.himalayaConfig,
      });
      log.debug(`envelope ${envelope.id} marked as seen`);
    } catch (err) {
      log.warn(`failed to mark envelope ${envelope.id} as seen: ${String(err)}`);
    }
  } else {
    log.debug(`skipping mark as seen (markSeen=false)`);
  }
}

async function deliverToHook(cfg: ImapHookRuntimeConfig, payload: unknown): Promise<void> {
  log.debug(`deliverToHook: POST to ${cfg.hookUrl}`);
  const payloadSize = JSON.stringify(payload).length;
  log.debug(`payload size: ${payloadSize} bytes`);

  const response = await fetch(cfg.hookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.hookToken}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    log.warn(`hook delivery failed (${response.status}): ${text.slice(0, 200)}`);
  } else {
    log.debug(`hook delivery succeeded: ${response.status}`);
  }
}

function truncateBody(body: string, maxBytes: number): string {
  if (Buffer.byteLength(body, "utf-8") <= maxBytes) {
    return body;
  }
  // Truncate to approximate byte limit (safe for multi-byte chars).
  const buf = Buffer.from(body, "utf-8");
  return buf.subarray(0, maxBytes).toString("utf-8");
}

function pruneSeenIds(): void {
  log.debug(`pruneSeenIds: current size=${seenIds.size}, max=${MAX_SEEN_IDS}`);
  if (seenIds.size <= MAX_SEEN_IDS) {
    log.debug("pruneSeenIds: no pruning needed");
    return;
  }
  // Drop oldest entries (Set iterates in insertion order).
  const excess = seenIds.size - MAX_SEEN_IDS;
  log.debug(`pruneSeenIds: pruning ${excess} entries`);
  let dropped = 0;
  for (const id of seenIds) {
    if (dropped >= excess) {
      break;
    }
    seenIds.delete(id);
    dropped += 1;
  }
  log.debug(`pruneSeenIds: new size=${seenIds.size}`);
}
