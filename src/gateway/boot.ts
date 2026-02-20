import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { CliDeps } from "../cli/deps.js";
import { agentCommand } from "../commands/agent.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
  resolveMainSessionKey,
} from "../config/sessions/main-session.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionStore, updateSessionStore } from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { type RuntimeEnv, defaultRuntime } from "../runtime.js";

function generateBootSessionId(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
  const suffix = crypto.randomUUID().slice(0, 8);
  return `boot-${ts}-${suffix}`;
}

type SessionMappingSnapshot = {
  storePath: string;
  sessionKey: string;
  canRestore: boolean;
  hadEntry: boolean;
  entry?: SessionEntry;
};

const log = createSubsystemLogger("gateway/boot");
const BOOT_FILENAME = "BOOT.md";

export type BootRunResult =
  | { status: "skipped"; reason: "missing" | "empty" | "already-ran" }
  | { status: "ran" }
  | { status: "failed"; reason: string };

/**
 * Module-level flag that tracks whether the startup notification has already been
 * sent within the current gateway process lifecycle.
 *
 * When the gateway restarts repeatedly (e.g. due to an invalid config), each restart
 * calls `startGatewaySidecars`, which fires the `gateway:startup` hook and ultimately
 * calls `runBootOnce`. Without dedup, every completed boot session sends its own
 * notification, flooding the user with duplicate messages.
 *
 * Using a module-level variable achieves a natural reset on full process restart
 * (i.e. when the gateway daemon is stopped and re-launched), while deduplicating
 * within a single OS process.
 */
let _bootNotificationSent = false;

/** Reset the dedup flag. Intended for use in tests only. */
export function _resetBootDedup(): void {
  _bootNotificationSent = false;
}

function buildBootPrompt(content: string) {
  return [
    "You are running a boot check. Follow BOOT.md instructions exactly.",
    "",
    "BOOT.md:",
    content,
    "",
    "If BOOT.md asks you to send a message, use the message tool (action=send with channel + target).",
    "Use the `target` field (not `to`) for message tool destinations.",
    `After sending with the message tool, reply with ONLY: ${SILENT_REPLY_TOKEN}.`,
    `If nothing needs attention, reply with ONLY: ${SILENT_REPLY_TOKEN}.`,
  ].join("\n");
}

async function loadBootFile(
  workspaceDir: string,
): Promise<{ content?: string; status: "ok" | "missing" | "empty" }> {
  const bootPath = path.join(workspaceDir, BOOT_FILENAME);
  try {
    const content = await fs.readFile(bootPath, "utf-8");
    const trimmed = content.trim();
    if (!trimmed) {
      return { status: "empty" };
    }
    return { status: "ok", content: trimmed };
  } catch (err) {
    const anyErr = err as { code?: string };
    if (anyErr.code === "ENOENT") {
      return { status: "missing" };
    }
    throw err;
  }
}

function snapshotMainSessionMapping(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): SessionMappingSnapshot {
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
  try {
    const store = loadSessionStore(storePath, { skipCache: true });
    const entry = store[params.sessionKey];
    if (!entry) {
      return {
        storePath,
        sessionKey: params.sessionKey,
        canRestore: true,
        hadEntry: false,
      };
    }
    return {
      storePath,
      sessionKey: params.sessionKey,
      canRestore: true,
      hadEntry: true,
      entry: structuredClone(entry),
    };
  } catch (err) {
    log.debug("boot: could not snapshot main session mapping", {
      sessionKey: params.sessionKey,
      error: String(err),
    });
    return {
      storePath,
      sessionKey: params.sessionKey,
      canRestore: false,
      hadEntry: false,
    };
  }
}

async function restoreMainSessionMapping(
  snapshot: SessionMappingSnapshot,
): Promise<string | undefined> {
  if (!snapshot.canRestore) {
    return undefined;
  }
  try {
    await updateSessionStore(
      snapshot.storePath,
      (store) => {
        if (snapshot.hadEntry && snapshot.entry) {
          store[snapshot.sessionKey] = snapshot.entry;
          return;
        }
        delete store[snapshot.sessionKey];
      },
      { activeSessionKey: snapshot.sessionKey },
    );
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export async function runBootOnce(params: {
  cfg: OpenClawConfig;
  deps: CliDeps;
  workspaceDir: string;
  agentId?: string;
}): Promise<BootRunResult> {
  // Dedup: skip if a boot notification was already sent during this process lifecycle.
  // This prevents duplicate notifications when the gateway restarts multiple times
  // in quick succession (e.g. after recovering from a config-invalid loop) and
  // several in-flight boot sessions all complete around the same time.
  //
  // The flag is set synchronously (before any `await`) once we decide to proceed,
  // so concurrent calls that arrive between event-loop ticks are blocked without
  // a separate lock. Because Node.js is single-threaded, the read-then-write below
  // is atomic at the JS level.
  if (_bootNotificationSent) {
    log.debug("boot: skipping — startup notification already sent in this process lifecycle");
    return { status: "skipped", reason: "already-ran" };
  }
  _bootNotificationSent = true;

  const bootRuntime: RuntimeEnv = {
    log: () => {},
    error: (message) => log.error(String(message)),
    exit: defaultRuntime.exit,
  };
  let result: Awaited<ReturnType<typeof loadBootFile>>;
  try {
    result = await loadBootFile(params.workspaceDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`boot: failed to read ${BOOT_FILENAME}: ${message}`);
    return { status: "failed", reason: message };
  }

  if (result.status === "missing" || result.status === "empty") {
    return { status: "skipped", reason: result.status };
  }

  const sessionKey = params.agentId
    ? resolveAgentMainSessionKey({ cfg: params.cfg, agentId: params.agentId })
    : resolveMainSessionKey(params.cfg);
  const message = buildBootPrompt(result.content ?? "");
  const sessionId = generateBootSessionId();
  const mappingSnapshot = snapshotMainSessionMapping({
    cfg: params.cfg,
    sessionKey,
  });

  let agentFailure: string | undefined;
  try {
    await agentCommand(
      {
        message,
        sessionKey,
        sessionId,
        deliver: false,
      },
      bootRuntime,
      params.deps,
    );
  } catch (err) {
    agentFailure = err instanceof Error ? err.message : String(err);
    log.error(`boot: agent run failed: ${agentFailure}`);
  }

  const mappingRestoreFailure = await restoreMainSessionMapping(mappingSnapshot);
  if (mappingRestoreFailure) {
    log.error(`boot: failed to restore main session mapping: ${mappingRestoreFailure}`);
  }

  if (!agentFailure && !mappingRestoreFailure) {
    return { status: "ran" };
  }
  const reasonParts = [
    agentFailure ? `agent run failed: ${agentFailure}` : undefined,
    mappingRestoreFailure ? `mapping restore failed: ${mappingRestoreFailure}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return { status: "failed", reason: reasonParts.join("; ") };
}
