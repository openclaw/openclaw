import type { EventEmitter } from "node:events";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { isVitestRuntimeEnv } from "../infra/env.js";
import { parseNodeOptionsTokens } from "../infra/node-options.js";

const SYSTEM_CA_WARMUP_WARNING_MS = 10_000;
const SYSTEM_CA_WORKER_SOURCE = String.raw`
  const { getCACertificates } = require("node:tls");
  const { parentPort } = require("node:worker_threads");

  try {
    const certificateCount = getCACertificates("system").length;
    parentPort.postMessage({ ok: true, certificateCount });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    parentPort.close();
  }
`;

type SystemCaWarmupWorker = Pick<EventEmitter, "once" | "removeAllListeners"> & {
  unref: () => void;
};

type SystemCaWarmupOptions = {
  env?: NodeJS.ProcessEnv;
  execArgv?: readonly string[];
  platform?: NodeJS.Platform;
  log?: { warn: (message: string) => void };
  warningMs?: number;
  createWorker?: (source: string, options: WorkerOptions) => SystemCaWarmupWorker;
};

type SystemCaWarmupMessage = { ok: true; certificateCount: number } | { ok: false; error: string };

function applySystemCaRuntimeOptions(enabled: boolean, args: readonly string[]): boolean {
  let result = enabled;
  for (const arg of args) {
    const match = /^--(?:(no)[-_])?use[-_]system[-_]ca(?:=.*)?$/u.exec(arg);
    if (match) {
      result = match[1] === undefined;
    }
  }
  return result;
}

function resolveEffectiveSystemCaEnabled(params: {
  env: NodeJS.ProcessEnv;
  execArgv: readonly string[];
}): boolean {
  // Node v26.5.0 gates macOS Keychain reads solely on effective --use-system-ca /
  // NODE_USE_SYSTEM_CA selection. --use-bundled-ca is additive, while --use-openssl-ca
  // cannot coexist with system CA (startup exits 9), so neither overrides this gate.
  // Scope: reads the env var, NODE_OPTIONS, and execArgv — the paths OpenClaw uses
  // (the gateway enables system CA via NODE_USE_SYSTEM_CA by default). The experimental
  // --experimental-config-file `nodeOptions.use-system-ca` source is intentionally not
  // parsed here; if it is ever the only enabler the warmup simply no-ops and the process
  // degrades to Node's original lazy (pre-fix) CA load — no regression, just unimproved.
  const fromEnvironment = params.env.NODE_USE_SYSTEM_CA === "1";
  const nodeOptions = parseNodeOptionsTokens(params.env.NODE_OPTIONS ?? "");
  const afterNodeOptions = applySystemCaRuntimeOptions(fromEnvironment, nodeOptions ?? []);
  return applySystemCaRuntimeOptions(afterNodeOptions, params.execArgv);
}

function isSystemCaWarmupMessage(value: unknown): value is SystemCaWarmupMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const message = value as Record<string, unknown>;
  return message.ok === true
    ? typeof message.certificateCount === "number"
    : message.ok === false && typeof message.error === "string";
}

/** Populate Node's process-wide macOS system CA cache without blocking the gateway event loop. */
export async function warmMacOSSystemCaOffMainThread(
  options: SystemCaWarmupOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const execArgv = options.execArgv ?? process.execArgv;
  const platform = options.platform ?? process.platform;
  const usesSystemCa = resolveEffectiveSystemCaEnabled({ env, execArgv });
  if (
    platform !== "darwin" ||
    !usesSystemCa ||
    (options.env === undefined && options.platform === undefined && isVitestRuntimeEnv(env))
  ) {
    return;
  }

  const worker = (
    options.createWorker ?? ((source, workerOptions) => new Worker(source, workerOptions))
  )(SYSTEM_CA_WORKER_SOURCE, { eval: true });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const warningTimer = setTimeout(() => {
      options.log?.warn(
        "macOS system CA warmup is still waiting for Keychain trust settings; channel startup remains deferred",
      );
    }, options.warningMs ?? SYSTEM_CA_WARMUP_WARNING_MS);
    warningTimer.unref?.();

    const settle = (finish: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(warningTimer);
      worker.removeAllListeners();
      finish();
    };

    worker.once("message", (value: unknown) => {
      settle(() => {
        if (!isSystemCaWarmupMessage(value)) {
          reject(new Error("macOS system CA warmup worker returned an invalid result"));
          return;
        }
        if (!value.ok) {
          reject(new Error(value.error));
          return;
        }
        resolve();
      });
    });
    worker.once("error", (error: Error) => settle(() => reject(error)));
    worker.once("exit", (code: number) => {
      settle(() =>
        reject(new Error(`macOS system CA warmup worker exited before replying (code ${code})`)),
      );
    });

    // A wedged trustd lookup must not keep an otherwise stopped gateway process alive.
    worker.unref();
  });
}
