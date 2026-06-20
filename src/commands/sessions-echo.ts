import { theme } from "../../packages/terminal-core/src/theme.js";
import { getRuntimeConfig } from "../config/config.js";
import { patchSessionEntry } from "../config/sessions.js";
import type { SessionEchoTarget, SessionEntry } from "../config/sessions/types.js";
import { normalizeEchoTargetId, targetMatchesSessionParticipant } from "../infra/outbound/echo.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { resolveSessionStoreTargetsOrExit } from "./session-store-targets.js";

type EchoAddOpts = {
  sessionKey: string;
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string;
  label?: string;
  echoUser: boolean;
  echoAssistant: boolean;
  store?: string;
  agent?: string;
  json?: boolean;
};

type EchoRemoveOpts = {
  sessionKey: string;
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string;
  store?: string;
  agent?: string;
  json?: boolean;
};

type EchoListOpts = {
  sessionKey: string;
  store?: string;
  agent?: string;
  json?: boolean;
};

function resolveStorePath(opts: { store?: string; agent?: string }, runtime: RuntimeEnv): string {
  if (opts.store) {
    return opts.store;
  }
  const cfg = getRuntimeConfig();
  const targets = resolveSessionStoreTargetsOrExit({
    cfg,
    opts: { store: opts.store, agent: opts.agent },
    runtime,
  });
  if (!targets || targets.length === 0) {
    throw new Error("No session store target resolved");
  }
  return targets[0].storePath;
}

export async function sessionsEchoAddCommand(
  opts: EchoAddOpts,
  runtime: RuntimeEnv,
): Promise<void> {
  const storePath = resolveStorePath(opts, runtime);
  const newTarget: SessionEchoTarget = {
    channel: opts.channel,
    to: opts.to,
    accountId: opts.accountId,
    threadId: opts.threadId,
    label: opts.label,
    echoUser: opts.echoUser ? undefined : false,
    echoAssistant: opts.echoAssistant ? undefined : false,
    addedAt: Date.now(),
  } as SessionEchoTarget;

  const MAX_ECHO_TARGETS = 16;
  let wasDuplicate = false;
  let wasAtLimit = false;
  let wasNotParticipant = false;
  const result = await patchSessionEntry({
    storePath,
    sessionKey: opts.sessionKey,
    preserveActivity: true,
    update: (entry: SessionEntry) => {
      // A mirror recipient must be a thread bound to this session, never an
      // arbitrary chat id. Reject anything that is not the session's known
      // participant; opt other threads in with /pin from that thread.
      if (!targetMatchesSessionParticipant(entry, newTarget)) {
        wasNotParticipant = true;
        return null;
      }
      const existing = entry.echoTargets ?? [];
      if (existing.length >= MAX_ECHO_TARGETS) {
        wasAtLimit = true;
        return null;
      }
      const duplicate = existing.find(
        (t) =>
          t.channel === newTarget.channel &&
          normalizeEchoTargetId(t.channel, t.to) ===
            normalizeEchoTargetId(newTarget.channel, newTarget.to) &&
          (t.accountId ?? "") === (newTarget.accountId ?? "") &&
          String(t.threadId ?? "") === String(newTarget.threadId ?? ""),
      );
      if (duplicate) {
        wasDuplicate = true;
        return null;
      }
      return { echoTargets: [...existing, newTarget] };
    },
  });

  if (!result) {
    runtime.error(`Session not found: ${opts.sessionKey}`);
    runtime.exit(1);
    return;
  }

  if (opts.json) {
    writeRuntimeJson(runtime, {
      ok: !wasAtLimit && !wasNotParticipant,
      added: !wasDuplicate && !wasAtLimit && !wasNotParticipant,
      echoTargets: result.echoTargets ?? [],
    });
    if (wasAtLimit || wasNotParticipant) {
      runtime.exit(1);
    }
  } else if (wasNotParticipant) {
    runtime.error(
      "Echo target must be a thread bound to this session. Use /pin from the target thread to opt it in.",
    );
    runtime.exit(1);
  } else if (wasAtLimit) {
    runtime.error(`Echo target limit reached (max ${MAX_ECHO_TARGETS})`);
    runtime.exit(1);
  } else if (wasDuplicate) {
    runtime.log(`${theme.muted("Already exists:")} echo target ${opts.channel} -> ${opts.to}`);
  } else {
    runtime.log(
      `${theme.success("Added")} echo target: ${opts.channel} -> ${opts.to}${opts.label ? ` (${opts.label})` : ""}`,
    );
  }
}

export async function sessionsEchoRemoveCommand(
  opts: EchoRemoveOpts,
  runtime: RuntimeEnv,
): Promise<void> {
  const storePath = resolveStorePath(opts, runtime);

  let wasNotFound = false;
  const result = await patchSessionEntry({
    storePath,
    sessionKey: opts.sessionKey,
    preserveActivity: true,
    update: (entry: SessionEntry) => {
      const existing = entry.echoTargets ?? [];
      const filtered = existing.filter(
        (t) =>
          !(
            t.channel === opts.channel &&
            normalizeEchoTargetId(t.channel, t.to) ===
              normalizeEchoTargetId(opts.channel, opts.to) &&
            (t.accountId ?? "") === (opts.accountId ?? "") &&
            String(t.threadId ?? "") === (opts.threadId ?? "")
          ),
      );
      if (filtered.length === existing.length) {
        wasNotFound = true;
        return null;
      }
      return { echoTargets: filtered.length > 0 ? filtered : undefined };
    },
  });

  if (!result) {
    runtime.error(`Session not found: ${opts.sessionKey}`);
    runtime.exit(1);
    return;
  }

  if (opts.json) {
    writeRuntimeJson(runtime, {
      ok: true,
      removed: !wasNotFound,
      echoTargets: result.echoTargets ?? [],
    });
  } else if (wasNotFound) {
    runtime.log(`${theme.muted("Not found:")} echo target ${opts.channel} -> ${opts.to}`);
  } else {
    runtime.log(`${theme.success("Removed")} echo target: ${opts.channel} -> ${opts.to}`);
  }
}

export async function sessionsEchoListCommand(
  opts: EchoListOpts,
  runtime: RuntimeEnv,
): Promise<void> {
  const storePath = resolveStorePath(opts, runtime);

  const result = await patchSessionEntry({
    storePath,
    sessionKey: opts.sessionKey,
    preserveActivity: true,
    update: () => null,
  });

  if (!result) {
    runtime.error(`Session not found: ${opts.sessionKey}`);
    runtime.exit(1);
    return;
  }

  const targets = result.echoTargets ?? [];

  if (opts.json) {
    writeRuntimeJson(runtime, { sessionKey: opts.sessionKey, echoTargets: targets });
    return;
  }

  if (targets.length === 0) {
    runtime.log(theme.muted("No echo targets configured for this session."));
    return;
  }

  runtime.log(`Echo targets for ${theme.heading(opts.sessionKey)}:\n`);
  for (const target of targets) {
    const label = target.label ? ` (${target.label})` : "";
    const flags = [
      target.echoUser === false ? "no-user" : null,
      target.echoAssistant === false ? "no-assistant" : null,
    ]
      .filter(Boolean)
      .join(", ");
    const flagStr = flags ? ` [${flags}]` : "";
    runtime.log(`  ${target.channel} -> ${target.to}${label}${flagStr}`);
  }
}
