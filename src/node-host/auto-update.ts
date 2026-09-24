import fs from "node:fs/promises";
import path from "node:path";
import { sleepWithAbort } from "@openclaw/retry";
import type { OpenClawConfig } from "../config/config.js";
import { createConfigIO } from "../config/io.js";
import { resolveStateDir } from "../config/paths.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { hasErrnoCode } from "../infra/errno.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { resolveEffectiveUpdateChannel, type UpdateChannel } from "../infra/update-channels.js";
import {
  compareSemverStrings,
  resolveNpmChannelTag,
  resolveUpdateInstallKind,
} from "../infra/update-check.js";
import { redactSensitiveText } from "../logging/redact.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { VERSION } from "../version.js";
import type { PreparedNodeRuntimeUpdate } from "./auto-update-install.js";
import { isNodeHostLauncherChild, requestNodeHostLauncherRestart } from "./launcher-client.js";

const CHECK_INTERVAL_MS = 60 * 60_000;
const IDLE_CHECK_INTERVAL_MS = 30_000;
const MIN_ACTIVATION_INTERVAL_MS = 12 * CHECK_INTERVAL_MS;

type NodeUpdateRuntime = {
  tryPauseForUpdate(): Promise<boolean>;
  resumeAfterUpdate(): void;
};

function updatesEnabled(config: OpenClawConfig, env: NodeJS.ProcessEnv): boolean {
  return (
    config.nodeHost?.autoUpdate?.enabled !== false &&
    config.update?.checkOnStart !== false &&
    !isTruthyEnvValue(env.OPENCLAW_NO_AUTO_UPDATE) &&
    !isTruthyEnvValue(env.OPENCLAW_NO_RESPAWN)
  );
}

/** Owns discovery and idle admission; the launcher owns executable activation. */
export function startNodeHostAutoUpdate(params: {
  runtime: NodeUpdateRuntime;
  /** Begin normal shutdown after the launcher has accepted the drained restart. */
  onRestartAccepted: () => void;
  log: (message: string) => void;
  signal: AbortSignal;
}): { stop: () => Promise<void> } {
  const controller = new AbortController();
  const signal = AbortSignal.any([params.signal, controller.signal]);
  const env = process.env;
  const stateDir = resolveStateDir(env);
  const configIO = createConfigIO({ env, observe: false, pluginValidation: "skip" });
  let pending: (PreparedNodeRuntimeUpdate & { channel: UpdateChannel }) | undefined;
  let paused = false;
  let handedOff = false;
  let waitingLogged = false;

  const readPolicy = async () => {
    const snapshot = await configIO.readConfigFileSnapshot();
    signal.throwIfAborted();
    if (!snapshot.valid) {
      throw new Error("Node auto-update deferred: fix the invalid OpenClaw configuration first.");
    }
    const channel = resolveEffectiveUpdateChannel({
      configChannel: snapshot.config.update?.channel,
      currentVersion: VERSION,
      installKind: "package",
    }).channel;
    return {
      enabled: updatesEnabled(snapshot.config, env) && (channel === "stable" || channel === "beta"),
      channel,
    };
  };

  const activationAllowed = async () => {
    try {
      // The launcher publishes this executable selector only after authenticated readiness.
      // Its lock and second check are authoritative across competing node processes.
      const current = await fs.lstat(path.join(stateDir, "node-runtime", "current"));
      signal.throwIfAborted();
      return Date.now() - current.mtimeMs >= MIN_ACTIVATION_INTERVAL_MS;
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        return true;
      }
      throw error;
    }
  };

  const tryActivate = async () => {
    const candidate = pending;
    if (!candidate || !(await activationAllowed())) {
      return CHECK_INTERVAL_MS;
    }
    signal.throwIfAborted();
    if (!(await params.runtime.tryPauseForUpdate())) {
      if (!waitingLogged) {
        params.log(
          `node auto-update ${candidate.version} is ready; waiting for active work to finish`,
        );
        waitingLogged = true;
      }
      return IDLE_CHECK_INTERVAL_MS;
    }
    paused = true;
    try {
      const { assertNodeRuntimeUpdateCompatible } = await import("./auto-update-compatibility.js");
      signal.throwIfAborted();
      await assertNodeRuntimeUpdateCompatible({
        packageRoot: candidate.packageRoot,
        stateDir,
        signal,
      });
      // Settings may change during download, state preflight, or the idle wait.
      const intervalAllowed = await activationAllowed();
      const policy = await readPolicy();
      signal.throwIfAborted();
      if (!policy.enabled || policy.channel !== candidate.channel || !intervalAllowed) {
        pending = undefined;
        return CHECK_INTERVAL_MS;
      }
      signal.throwIfAborted();
      await requestNodeHostLauncherRestart({
        runtimeRoot: candidate.runtimeRoot,
        version: candidate.version,
      });
      handedOff = true;
      params.log(`node auto-update restarting into ${candidate.version}`);
      params.onRestartAccepted();
      return CHECK_INTERVAL_MS;
    } finally {
      if (!handedOff) {
        params.runtime.resumeAfterUpdate();
        paused = false;
      }
    }
  };

  const check = async () => {
    const policy = await readPolicy();
    if (!policy.enabled) {
      pending = undefined;
      return CHECK_INTERVAL_MS;
    }
    if (pending) {
      if (pending.channel !== policy.channel) {
        pending = undefined;
        return CHECK_INTERVAL_MS;
      }
      return await tryActivate();
    }
    const available = await resolveNpmChannelTag({
      channel: policy.channel,
      env,
      runCommand: (argv, options) => runCommandWithTimeout(argv, { ...options, signal }),
    });
    signal.throwIfAborted();
    if (available.error) {
      throw new Error(`Node auto-update discovery failed: ${available.error}`);
    }
    if (!available.version || (compareSemverStrings(available.version, VERSION) ?? 0) <= 0) {
      return CHECK_INTERVAL_MS;
    }
    if (!(await activationAllowed())) {
      return CHECK_INTERVAL_MS;
    }
    params.log(`node auto-update preparing ${available.version}`);
    const { prepareNodeRuntimeUpdate } = await import("./auto-update-install.js");
    const installPolicy = await readPolicy();
    if (!installPolicy.enabled || installPolicy.channel !== policy.channel) {
      return CHECK_INTERVAL_MS;
    }
    signal.throwIfAborted();
    const candidate = await prepareNodeRuntimeUpdate({
      targetVersion: available.version,
      stateDir,
      signal,
    });
    signal.throwIfAborted();
    for (const warning of candidate.warnings ?? []) {
      params.log(redactSensitiveText(warning));
    }
    const currentPolicy = await readPolicy();
    if (!currentPolicy.enabled || currentPolicy.channel !== policy.channel) {
      return CHECK_INTERVAL_MS;
    }
    pending = { ...candidate, channel: policy.channel };
    waitingLogged = false;
    return await tryActivate();
  };

  const task = (async () => {
    if (!isNodeHostLauncherChild()) {
      return;
    }
    const root = await resolveOpenClawPackageRoot({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
    });
    if (!root || (await resolveUpdateInstallKind(root, { signal })) !== "package") {
      return;
    }
    while (!signal.aborted) {
      let delay = CHECK_INTERVAL_MS;
      try {
        delay = await check();
      } catch (error) {
        if (signal.aborted) {
          break;
        }
        pending = undefined;
        params.log(redactSensitiveText(String(error)));
      }
      if (handedOff) {
        break;
      }
      await sleepWithAbort(delay, signal, { ref: false });
    }
  })()
    .catch((error: unknown) => {
      if (!signal.aborted) {
        params.log(`node auto-update stopped: ${redactSensitiveText(String(error))}`);
      }
    })
    .finally(() => {
      if (paused && !handedOff) {
        params.runtime.resumeAfterUpdate();
      }
    });

  return {
    stop: async () => {
      controller.abort();
      await task;
    },
  };
}
