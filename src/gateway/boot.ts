import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { agentCommand } from "../commands/agent.js";
import { resolveMainSessionKey } from "../config/sessions/main-session.js";
import { resolveAgentIdFromSessionKey } from "../config/sessions/main-session.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionStore } from "../config/sessions/store.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { type RuntimeEnv, defaultRuntime } from "../runtime.js";

function generateBootSessionId(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
  const suffix = crypto.randomUUID().slice(0, 8);
  return `boot-${ts}-${suffix}`;
}

/**
 * Resolve the session ID for the boot message.
 * If there's an existing session mapped to the main session key, reuse it to avoid orphaning.
 * Otherwise, generate a new ephemeral boot session ID.
 */
function resolveBootSessionId(cfg: OpenClawConfig): string {
  const sessionKey = resolveMainSessionKey(cfg);
  const agentId = resolveAgentIdFromSessionKey(sessionKey);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });

  try {
    const sessionStore = loadSessionStore(storePath);
    const existingEntry = sessionStore[sessionKey];

    if (existingEntry?.sessionId) {
      log.info("reusing existing session for boot message", {
        sessionKey,
        sessionId: existingEntry.sessionId,
      });
      return existingEntry.sessionId;
    }
  } catch (err) {
    // If we can't load the session store (e.g., first boot), fall through to generate new ID
    log.debug("could not load session store for boot; generating new session ID", {
      error: String(err),
    });
  }

  const newSessionId = generateBootSessionId();
  log.info("generating new boot session", { sessionKey, sessionId: newSessionId });
  return newSessionId;
}

const log = createSubsystemLogger("gateway/boot");
const BOOT_FILENAME = "BOOT.md";

export type BootRunResult =
  | { status: "skipped"; reason: "missing" | "empty" }
  | { status: "ran" }
  | { status: "failed"; reason: string };

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

export async function runBootOnce(params: {
  cfg: OpenClawConfig;
  deps: CliDeps;
  workspaceDir: string;
}): Promise<BootRunResult> {
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

  const sessionKey = resolveMainSessionKey(params.cfg);
  const message = buildBootPrompt(result.content ?? "");
  const sessionId = resolveBootSessionId(params.cfg);

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
    return { status: "ran" };
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    log.error(`boot: agent run failed: ${messageText}`);
    return { status: "failed", reason: messageText };
  }
}
