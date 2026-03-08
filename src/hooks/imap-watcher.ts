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
let generation = 0; // Incremented on each start to detect stale poll cycles from previous instances.

function isHimalayaAvailable(): boolean {
  return hasBinary("himalaya");
}

export type ImapWatcherStartResult = {
  started: boolean;
  reason?: string;
};

export type StartImapWatcherOptions = {
  /**
   * When true, skip the hooks.enabled check. Used by the run command
   * which provides all necessary configuration via overrides.
   */
  skipHooksEnabledCheck?: boolean;
};

/**
 * Start the IMAP watcher service.
 * Called by the gateway if hooks.imap is configured.
 */
export async function startImapWatcher(
  cfg: OpenClawConfig,
  overrides?: import("./imap.js").ImapHookOverrides,
  opts?: StartImapWatcherOptions,
): Promise<ImapWatcherStartResult> {
  log.debug("startImapWatcher called");

  if (!opts?.skipHooksEnabledCheck && !cfg.hooks?.enabled) {
    log.debug("hooks not enabled, skipping start");
    return { started: false, reason: "hooks not enabled" };
  }

  log.debug("resolving imap config");
  const resolved = await resolveImapHookRuntimeConfig(cfg, overrides ?? {});
  if (!resolved.ok) {
    log.debug(`config resolution failed: ${resolved.error}`);
    return { started: false, reason: resolved.error };
  }

  log.debug(`checking himalaya availability...`);
  if (!isHimalayaAvailable()) {
    log.debug("himalaya binary not found");
    return { started: false, reason: "himalaya binary not found" };
  }
  log.debug("himalaya binary found");

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
  log.debug(`  - allowedSenders: ${runtimeConfig.allowedSenders.length}`);

  currentConfig = runtimeConfig;
  shuttingDown = false;
  seenIds = new Set();
  generation += 1;
  const currentGeneration = generation;

  // Schedule the first poll immediately.
  log.debug("scheduling first poll immediately");
  schedulePoll(runtimeConfig, 0, currentGeneration);

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

function schedulePoll(cfg: ImapHookRuntimeConfig, delayMs: number, expectedGeneration: number) {
  if (shuttingDown) {
    log.debug("schedulePoll: shutting down, not scheduling");
    return;
  }
  log.debug(
    `schedulePoll: scheduling next poll in ${delayMs}ms (generation=${expectedGeneration})`,
  );
  pollTimer = setTimeout(() => {
    void runPollCycle(cfg, expectedGeneration);
  }, delayMs);
}

async function runPollCycle(cfg: ImapHookRuntimeConfig, expectedGeneration: number): Promise<void> {
  log.debug(`runPollCycle started (generation=${expectedGeneration})`);

  if (shuttingDown || !currentConfig) {
    log.debug("shuttingDown or no currentConfig, aborting poll cycle");
    return;
  }

  // Check if this is a stale poll cycle from a previous watcher instance
  if (expectedGeneration !== generation) {
    log.debug(
      `stale poll cycle detected (expected=${expectedGeneration}, current=${generation}), aborting`,
    );
    return;
  }

  try {
    // Paginate through all envelope pages to ensure we don't miss messages
    // when markSeen is disabled (messages stay unread, so they remain on page 1)
    let page = 1;
    let hasMorePages = true;
    let totalProcessed = 0;

    while (hasMorePages) {
      // Check generation before fetching each page
      if (expectedGeneration !== generation) {
        log.debug(`stale poll cycle detected during pagination, aborting`);
        break;
      }

      if (shuttingDown) {
        log.debug("shutting down, breaking out of pagination loop");
        break;
      }

      log.debug(
        `listing envelopes page ${page}: account=${cfg.account}, folder=${cfg.folder}, query=${cfg.query}, pageSize=${ENVELOPE_PAGE_SIZE}`,
      );
      const envelopes = await listEnvelopes({
        account: cfg.account,
        folder: cfg.folder,
        query: cfg.query,
        pageSize: ENVELOPE_PAGE_SIZE,
        page,
        config: cfg.himalayaConfig,
      });

      log.debug(`retrieved ${envelopes.length} envelopes from himalaya page ${page}`);
      const hasFullPage = envelopes.length === ENVELOPE_PAGE_SIZE;

      // Stop if no more envelopes on this page
      if (envelopes.length === 0) {
        log.debug(`no envelopes on page ${page}, stopping pagination`);
        hasMorePages = false;
        break;
      }

      if (page === 1 && envelopes.length > 0) {
        log.debug(
          `first envelope: id=${envelopes[0].id}, subject="${envelopes[0].subject}", from="${envelopes[0].from}"`,
        );
      }

      const newEnvelopes = envelopes.filter((e) => e.id && !seenIds.has(e.id));
      log.debug(`found ${newEnvelopes.length} new envelopes on page ${page} (not in seenIds set)`);

      // Continue pagination even when this page is fully seen so unread
      // messages on deeper pages are still retried after partial failures.
      if (newEnvelopes.length === 0) {
        log.debug(`all envelopes on page ${page} already processed, continuing pagination`);
        page++;
        continue;
      }

      const allowedEnvelopes = newEnvelopes.filter((envelope) =>
        isAllowedSender(envelope.from, cfg.allowedSenders),
      );
      if (allowedEnvelopes.length < newEnvelopes.length) {
        log.debug(
          `filtered ${newEnvelopes.length - allowedEnvelopes.length} envelopes by allowlist on page ${page}`,
        );
      }
      if (allowedEnvelopes.length === 0) {
        log.debug(`no allowlisted senders on page ${page}, continuing pagination`);
        page++;
        continue;
      }

      for (const envelope of allowedEnvelopes) {
        // Check generation before processing each envelope
        if (expectedGeneration !== generation) {
          log.debug(`stale poll cycle detected during envelope processing, aborting`);
          break;
        }

        if (shuttingDown) {
          log.debug("shutting down, breaking out of envelope processing loop");
          break;
        }

        // Guard: ensure only allowlisted senders reach hook delivery.
        if (!isAllowedSender(envelope.from, cfg.allowedSenders)) {
          log.warn(
            `skipping envelope ${envelope.id} from non-allowlisted sender: ${envelope.from}`,
          );
          continue;
        }

        log.debug(
          `processing envelope ${envelope.id}: "${envelope.subject}" from "${envelope.from}"`,
        );
        try {
          await processEnvelope(cfg, envelope);
          // Check generation after processEnvelope to detect reloads that occurred during processing
          if (expectedGeneration !== generation) {
            log.debug(
              `stale poll cycle detected after envelope ${envelope.id} processed, aborting`,
            );
            break;
          }
          seenIds.add(envelope.id);
          totalProcessed++;
          log.debug(`envelope ${envelope.id} processed and added to seenIds`);
        } catch (err) {
          log.error(`failed to process envelope ${envelope.id}: ${String(err)}`);
        }
      }

      if (!hasFullPage) {
        log.debug(`page ${page} returned ${envelopes.length} envelopes; stopping pagination`);
        hasMorePages = false;
        break;
      }

      page++;
    }

    log.debug(`pagination complete, processed ${totalProcessed} envelopes total`);
    pruneSeenIds();
  } catch (err) {
    log.error(`poll cycle failed: ${String(err)}`);
  }

  // Check generation before rescheduling
  if (expectedGeneration !== generation) {
    log.debug(`stale poll cycle detected before reschedule, not rescheduling`);
    return;
  }

  // Schedule next poll.
  log.debug(`scheduling next poll in ${cfg.pollIntervalSeconds}s`);
  schedulePoll(cfg, cfg.pollIntervalSeconds * 1000, expectedGeneration);
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
      const msg = `failed to read message ${envelope.id}: ${String(err)}`;
      log.error(msg);
      throw new Error(msg, { cause: err });
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
  log.debug(`payload subject: "${envelope.subject}"`);
  log.debug(`payload from: "${envelope.from}"`);
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
  const payloadJson = JSON.stringify(payload);
  log.debug(`payload: ${payloadJson}`);
  log.debug(`payload size: ${payloadJson.length} bytes`);

  const controller = new AbortController();
  const timeoutMs = 30_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(cfg.hookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.hookToken}`,
      },
      body: payloadJson,
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      clearTimeout(timeout);
      const msg = `hook delivery failed (${response.status}): ${text.slice(0, 200)}`;
      log.error(msg);
      throw new Error(msg);
    }
    clearTimeout(timeout);
    log.debug(`hook delivery succeeded: ${response.status}`);
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === "AbortError") {
      const msg = `hook delivery timed out after ${timeoutMs}ms`;
      log.error(msg);
      throw new Error(msg, { cause: err });
    }
    throw err;
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
  // Keep the most recent entries. Since Set iterates in insertion order and
  // polling adds page 1 (newest) first, we convert to array and slice from
  // the end to retain recent IDs and drop the oldest ones.
  const idsArray = Array.from(seenIds);
  const excess = idsArray.length - MAX_SEEN_IDS;
  log.debug(`pruneSeenIds: pruning ${excess} oldest entries`);
  const keptIds = idsArray.slice(excess);
  seenIds = new Set(keptIds);
  log.debug(`pruneSeenIds: new size=${seenIds.size}`);
}

function isAllowedSender(from: string, allowedSenders: string[]): boolean {
  const normalizedAllowed = allowedSenders.map((sender) => sender.toLowerCase().trim());
  if (normalizedAllowed.length === 0) {
    return false;
  }
  const normalizedFrom = from.toLowerCase().trim();
  if (!normalizedFrom) {
    return false;
  }
  const senderAddress = extractSenderAddress(normalizedFrom);
  const allowed = senderAddress ? normalizedAllowed.includes(senderAddress) : false;
  log.debug(
    `allowlist check: from="${from}" normalized="${normalizedFrom}" sender=${senderAddress ?? ""} allowed=${normalizedAllowed.join(",")} result=${allowed}`,
  );
  return allowed;
}

function extractSenderAddress(from: string): string | null {
  const emailPattern = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
  const bracketMatch = from.match(/<([^<>]+)>/);
  if (bracketMatch?.[1]) {
    const bracketEmail = bracketMatch[1].match(emailPattern)?.[0];
    return bracketEmail ? bracketEmail.toLowerCase().trim() : null;
  }
  const matches = from.match(new RegExp(emailPattern.source, "gi")) ?? [];
  const normalized = matches.map((value) => value.toLowerCase().trim()).filter(Boolean);
  const unique = Array.from(new Set(normalized));
  if (unique.length === 1 && from === unique[0]) {
    return unique[0];
  }
  return null;
}
