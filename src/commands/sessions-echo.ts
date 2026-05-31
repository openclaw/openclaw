import { getRuntimeConfig } from "../config/config.js";
import { patchSessionEntry } from "../config/sessions.js";
import type { SessionEchoTarget, SessionEntry } from "../config/sessions/types.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { theme } from "../terminal/theme.js";
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
    echoUser: opts.echoUser === false ? false : undefined,
    echoAssistant: opts.echoAssistant === false ? false : undefined,
    addedAt: Date.now(),
  } as SessionEchoTarget;

  const result = await patchSessionEntry({
    storePath,
    sessionKey: opts.sessionKey,
    preserveActivity: true,
    update: (entry: SessionEntry) => {
      const existing = entry.echoTargets ?? [];
      const duplicate = existing.find(
        (t) => t.channel === newTarget.channel && t.to === newTarget.to,
      );
      if (duplicate) {
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
    writeRuntimeJson(runtime, { ok: true, echoTargets: result.echoTargets ?? [] });
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

  const result = await patchSessionEntry({
    storePath,
    sessionKey: opts.sessionKey,
    preserveActivity: true,
    update: (entry: SessionEntry) => {
      const existing = entry.echoTargets ?? [];
      const filtered = existing.filter(
        (t) => !(t.channel === opts.channel && t.to === opts.to),
      );
      if (filtered.length === existing.length) {
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
    writeRuntimeJson(runtime, { ok: true, echoTargets: result.echoTargets ?? [] });
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

  runtime.log(`Echo targets for ${theme.bold(opts.sessionKey)}:\n`);
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
