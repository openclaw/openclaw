import fs from "node:fs";
import path from "node:path";
import { isStandaloneRuntimeExecutable } from "../../cli-invocation.mjs";
import {
  isDisposableInstallPath,
  resolveDurableServiceBinDir,
  resolveDurableServiceCli,
  type DurableServiceCliReplacement,
} from "../daemon/durable-service-entrypoint.js";
import type { PlannedCliEntrypoint } from "../daemon/program-args.js";
import {
  resolveBunRuntimeInfo,
  resolvePinnedDaemonRuntimePath,
  resolvePreferredBunPath,
  resolvePreferredNodePath,
} from "../daemon/runtime-paths.js";
import type { GatewayServiceEnvironmentValueSource } from "../daemon/service-types.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import type { DaemonInstallWarnFn } from "./daemon-install-runtime-warning.js";
import type { GatewayDaemonRuntime } from "./daemon-runtime.js";

export type GatewayInstallPlan = {
  runtime: GatewayDaemonRuntime;
  programArguments: string[];
  workingDirectory?: string;
  environment: Record<string, string | undefined>;
  environmentValueSources?: Record<string, GatewayServiceEnvironmentValueSource | undefined>;
  /** Durable copy the service install must (re)place; see installDurableServiceCli. */
  durableCliReplacement?: DurableServiceCliReplacement;
};

function resolveGatewayDevMode(): boolean {
  const entry = process.argv[1];
  const normalizedEntry = entry?.replaceAll("\\", "/");
  return (
    normalizedEntry !== undefined &&
    normalizedEntry.includes("/src/") &&
    normalizedEntry.endsWith(".ts")
  );
}

/** Use the running Bun only when implicit Node discovery found no supported runtime. */
export async function resolveRunningBunFallback(params: {
  env: Record<string, string | undefined>;
  /** Null carries an already completed discovery with no supported Node. */
  nodePath?: string | null;
}): Promise<string | undefined> {
  if (!process.versions.bun) {
    return undefined;
  }
  const nodePath =
    params.nodePath === undefined
      ? await resolvePreferredNodePath({ env: params.env, runtime: "node" })
      : params.nodePath;
  if (
    nodePath ||
    (await resolveBunRuntimeInfo(process.execPath, params.env)).status !== "supported"
  ) {
    return undefined;
  }
  return process.execPath;
}

export async function resolveDaemonInstallRuntimeInputs(params: {
  env: Record<string, string | undefined>;
  runtime: GatewayDaemonRuntime;
  runtimeExplicit?: boolean;
  devMode?: boolean;
  runtimePath?: string;
  pinnedRuntimePath?: string;
  wrapperPath?: string;
  warn?: DaemonInstallWarnFn;
}): Promise<{ devMode: boolean; runtime: GatewayDaemonRuntime; runtimePath?: string }> {
  const devMode = params.devMode ?? resolveGatewayDevMode();
  if (params.wrapperPath?.trim()) {
    return { devMode, runtime: params.runtime, runtimePath: params.runtimePath };
  }
  if (params.runtime === "standalone") {
    const executable =
      params.pinnedRuntimePath ??
      params.runtimePath ??
      (isStandaloneRuntimeExecutable() ? process.execPath : undefined);
    if (!executable) {
      throw new Error(
        "Standalone services require --runtime-path pointing to a complete standalone artifact.",
      );
    }
    const runtimePath = await resolvePinnedDaemonRuntimePath(executable, "standalone", params.env);
    return { devMode: false, runtime: "standalone", runtimePath };
  }
  const pinnedRuntimePath =
    params.pinnedRuntimePath === undefined
      ? undefined
      : await resolvePinnedDaemonRuntimePath(params.pinnedRuntimePath, params.runtime, params.env);
  const runtimePath =
    pinnedRuntimePath ??
    params.runtimePath ??
    (params.runtime === "bun"
      ? await resolvePreferredBunPath({ env: params.env, runtime: params.runtime })
      : await resolvePreferredNodePath({ env: params.env, runtime: params.runtime }));
  if (
    params.runtime === "node" &&
    !params.runtimeExplicit &&
    params.pinnedRuntimePath === undefined &&
    params.runtimePath === undefined &&
    runtimePath === undefined
  ) {
    const bunPath = await resolveRunningBunFallback({ env: params.env, nodePath: null });
    if (bunPath) {
      params.warn?.("No supported Node runtime was found; using the running Bun for the service.");
      return { devMode, runtime: "bun", runtimePath: bunPath };
    }
  }
  return { devMode, runtime: params.runtime, runtimePath };
}

/** Wrapper and standalone services run their own executable, never the CLI entrypoint. */
function runsCliEntrypoint(params: { runtime: GatewayDaemonRuntime; wrapperPath?: string }) {
  return !params.wrapperPath?.trim() && params.runtime !== "standalone";
}

/**
 * Runtime inputs plus the CLI entrypoint the service runs: the retained `serviceCli`, the
 * durable copy that replaces a disposable npx, dlx, or bunx CLI, or undefined for this CLI.
 * Runtime and wrapper inputs are validated first. Nothing installs here: with
 * `installDurableCli` the durable copy becomes `durableCliReplacement`, which the service install
 * checks and reuses or replaces under the package lock; otherwise only a checked copy is reused.
 */
export async function resolveDaemonInstallPlanInputs(
  params: Parameters<typeof resolveDaemonInstallRuntimeInputs>[0] & {
    /** Which service runs the CLI; gateway and node services enter it differently. */
    service: "gateway" | "node";
    serviceCli?: { entrypoint: string | null };
    installDurableCli?: boolean;
  },
): Promise<
  Awaited<ReturnType<typeof resolveDaemonInstallRuntimeInputs>> & {
    cliEntrypoint?: string | PlannedCliEntrypoint;
    durableCliReplacement?: DurableServiceCliReplacement;
  }
> {
  const inputs = await resolveDaemonInstallRuntimeInputs({
    ...params,
    devMode: params.serviceCli ? false : params.devMode,
  });
  const retained = params.serviceCli?.entrypoint;
  const durable =
    retained || inputs.devMode || !runsCliEntrypoint({ ...inputs, wrapperPath: params.wrapperPath })
      ? undefined
      : await resolveDurableServiceCli(params.env, {
          install: params.installDurableCli === true,
          service: params.service,
        });
  return {
    ...inputs,
    cliEntrypoint: retained ?? durable?.entrypoint,
    ...(durable?.replacement ? { durableCliReplacement: durable.replacement } : {}),
  };
}

export function resolveDaemonRuntimeBinDir(runtimePath?: string): string[] | undefined {
  const trimmed = runtimePath?.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) {
    return undefined;
  }
  return [path.dirname(trimmed)];
}

function safeRealpathSync(inputPath: string): string | undefined {
  try {
    return fs.realpathSync.native(inputPath);
  } catch {
    return undefined;
  }
}

export function resolveDaemonServicePathDirs(params: {
  runtimePath?: string;
  argv?: string[];
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** The service install (re)places the durable copy, so its launcher does not exist yet. */
  durableCliPlanned?: boolean;
}): string[] | undefined {
  const platform = params.platform ?? process.platform;
  const argv = params.argv ?? process.argv;
  const env = params.env ?? process.env;
  const argv1 = argv[1]?.trim();
  const dirs = new Set(resolveDaemonRuntimeBinDir(params.runtimePath));
  // An npx, dlx, or temp folder goes stale once its runner evicts it.
  const addDurable = (dir: string) => {
    if (!isDisposableInstallPath(safeRealpathSync(dir) ?? path.resolve(dir))) {
      dirs.add(dir);
    }
  };
  const commandName = path.basename(argv1 ?? "");
  // From npx or dlx the service runs the durable copy, so its launcher replaces the cache's.
  const durableBinDir =
    argv1 && isDisposableInstallPath(safeRealpathSync(argv1) ?? path.resolve(argv1))
      ? resolveDurableServiceBinDir(env, platform, { planned: params.durableCliPlanned })
      : undefined;
  if (durableBinDir) {
    dirs.add(durableBinDir);
  }

  if (
    argv1 &&
    path.isAbsolute(argv1) &&
    (commandName === "openclaw" ||
      (platform === "win32" &&
        ["openclaw.cmd", "openclaw.ps1", "openclaw.exe"].includes(commandName)))
  ) {
    addDurable(path.dirname(argv1));
  }

  const argvRealpath = argv1 && path.isAbsolute(argv1) ? safeRealpathSync(argv1) : undefined;
  for (const rawSegment of (env.PATH ?? "").split(path.delimiter)) {
    const segment = rawSegment.trim();
    if (!path.isAbsolute(segment)) {
      continue;
    }
    const candidate = path.join(segment, platform === "win32" ? "openclaw.cmd" : "openclaw");
    if (!fs.existsSync(candidate)) {
      continue;
    }
    const candidateRealpath = safeRealpathSync(candidate);
    if (argvRealpath && candidateRealpath && candidateRealpath !== argvRealpath) {
      // Update invokes dist/index.js; the same installation's shim targets openclaw.mjs.
      const activeRoot = resolveOpenClawPackageRootSync({ argv1: argvRealpath });
      if (
        !activeRoot ||
        resolveOpenClawPackageRootSync({ argv1: candidateRealpath }) !== activeRoot
      ) {
        continue;
      }
    }
    addDurable(segment);
  }

  return dirs.size > 0 ? [...dirs] : undefined;
}
