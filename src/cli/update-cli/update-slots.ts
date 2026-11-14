// Updates for user-owned npm and git installs on Linux and macOS: stage the
// inactive runtime slot, prove it starts, flip slots.json, then restart the
// Gateway so its supervisor starts the new slot through the frozen launcher.
// `openclaw update` and the Gateway's update.run (chat `/update`) both run here.
import fs from "node:fs/promises";
import path from "node:path";
import { readConfigFileSnapshot } from "../../config/config.js";
import {
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
} from "../../daemon/constants.js";
import { readLaunchAgentProgramArgumentsFromFile } from "../../daemon/launchd-plist.js";
import { resolveLaunchAgentPlistPath } from "../../daemon/launchd-service-files.js";
import { resolveSystemdUnitPath } from "../../daemon/systemd-service-files.js";
import { parseSystemdExecStart } from "../../daemon/systemd-unit.js";
import { callGateway } from "../../gateway/call.js";
import { resolveBrewOpenClawPath } from "../../infra/brew.js";
import { isContainerEnvironment } from "../../infra/container-environment.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { formatInstallOwnerMessage, readInstallOwner } from "../../infra/install-owner.js";
import { compareSemverStrings } from "../../infra/npm-registry-spec.js";
import { resolveOpenClawPackageRoot } from "../../infra/openclaw-root.js";
import { readPackageVersion } from "../../infra/package-json.js";
import { isPathInside } from "../../infra/path-guards.js";
import {
  acquireRuntimeSlotsLock,
  activateRuntimeSlot,
  ensureRuntimeSlots,
  fetchRuntimeSlotGitTarget,
  readRuntimePointer,
  resolveRuntimeSlotsDir,
  RUNTIME_SLOT_TRIAL_STARTS,
  runtimeSlotEnv,
  sameRuntimeRoot,
  selectInactiveSlot,
  smokeRuntimeSlot,
  stageRuntimeSlot,
  waitForRuntimeSlotOutcome,
  type RuntimeSlotOutcome,
  type RuntimeSlotSource,
} from "../../infra/runtime-slots.js";
import { channelToNpmTag, DEV_BRANCH, type UpdateChannel } from "../../infra/update-channels.js";
import {
  createSystemPackageOwnershipInspection,
  SystemPackageOwnershipError,
} from "../../infra/update-system-package-ownership.js";
import { runCommandWithTimeout } from "../../process/exec-runner.js";
import { defaultRuntime } from "../../runtime.js";
import { exitCliAfterOutput } from "../one-shot-exit.js";
import {
  isGitCheckout,
  normalizeTag,
  parseUpdateChannel,
  parseUpdateTimeoutMs,
  resolveTargetVersion,
  resolveUpdateRoot,
  type UpdateCommandOptions,
} from "./shared.js";
import { persistRequestedUpdateChannel } from "./update-command-config.js";

const DEFAULT_STAGE_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_RESTART_WAIT_MS = 180_000;

export type RuntimeSlotUpdateResult = {
  status: "ok" | "skipped" | "error";
  mode: "npm" | "git";
  reason?: string;
  before?: string | null;
  after?: string | null;
  slot?: string;
  restart?: RuntimeSlotOutcome | "next-start" | "self";
  message: string;
};

export type UpdateOwner =
  | { kind: "slots"; root: string; git: boolean }
  | { kind: "external"; reason: string; message: string };

/**
 * Who updates this install. npm installs, git checkouts and installs already on
 * the slot layout update through runtime slots. Package managers, app bundles
 * and container images own their files: `openclaw update` names their command.
 */
export async function resolveUpdateOwner(root: string, tag: string): Promise<UpdateOwner> {
  const external = (reason: string, message: string): UpdateOwner => ({
    kind: "external",
    reason,
    message,
  });
  const appOwner = await readInstallOwner(root);
  if (appOwner) {
    return external("app-owned-install", formatInstallOwnerMessage(appOwner));
  }
  if (isContainerEnvironment()) {
    return external(
      "container-image-install",
      `This OpenClaw runs from a container image. Pull the new image and recreate the container: docker pull ghcr.io/openclaw/openclaw:${tag}`,
    );
  }
  if (process.versions.bun) {
    return external(
      "bun-install",
      `This OpenClaw runs under Bun. Update it with: bun add -g --trust openclaw@${tag}`,
    );
  }
  if (await resolveBrewOpenClawPath(root)) {
    return external(
      "homebrew-install",
      "Homebrew owns this OpenClaw. Update it with: brew upgrade openclaw-cli",
    );
  }
  const owned = await createSystemPackageOwnershipInspection()
    .assertUnowned(root)
    .then(
      () => null,
      (error: unknown) => (error instanceof SystemPackageOwnershipError ? error : null),
    );
  if (owned) {
    return external(owned.reason, owned.message);
  }
  const git = await isGitCheckout(root);
  const dir = resolveRuntimeSlotsDir();
  if (
    git ||
    isPathInside(dir, root) ||
    readRuntimePointer(dir) !== null ||
    root.split(path.sep).includes("node_modules")
  ) {
    return { kind: "slots", root, git };
  }
  return external(
    "unmanaged-package-install",
    `OpenClaw cannot tell how ${root} was installed. Reinstall it with: npm install -g openclaw@${tag}`,
  );
}

/** The installed service's argv, read from its definition file without D-Bus or launchctl. */
async function readServiceArgs(env: NodeJS.ProcessEnv): Promise<string[] | undefined> {
  if (process.platform === "darwin") {
    const plist = await readLaunchAgentProgramArgumentsFromFile(
      resolveLaunchAgentPlistPath(env),
    ).catch(() => null);
    return plist?.programArguments;
  }
  const unit = await fs.readFile(resolveSystemdUnitPath(env), "utf8").catch(() => "");
  const line = unit.split("\n").find((entry) => entry.startsWith("ExecStart="));
  return line ? parseSystemdExecStart(line.slice("ExecStart=".length)) : undefined;
}

/** The service's own Node and port: never PATH for Node, never config for the port. */
function readServiceCommand(args: string[] | undefined) {
  const node = args?.find(
    (arg) => path.isAbsolute(arg) && /^node(?:\.exe)?$/u.test(path.basename(arg)),
  );
  const port = Number(args?.[args.indexOf("--port") + 1]);
  return {
    node: node ?? process.execPath,
    port: args?.includes("--port") && Number.isInteger(port) ? port : undefined,
  };
}

/**
 * A service that does not run the launcher yet gets its definition written once,
 * by the staged release, which also restarts it. Its origin entry still hands
 * off to the launcher if that rewrite cannot run (for example without D-Bus).
 */
async function moveServiceToLauncher(params: {
  args: string[] | undefined;
  port: number | undefined;
  dir: string;
  staged: string;
  node: string;
  env: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const launcher = path.join(params.dir, "launcher.mjs");
  if (!params.args || params.args.some((arg) => sameRuntimeRoot(arg, launcher))) {
    return false;
  }
  const entry = path.join(params.staged, "openclaw.mjs");
  // Keep the port the service listens on, not the configured default.
  const port = params.port ? ["--port", String(params.port)] : [];
  const result = await runCommandWithTimeout(
    [params.node, entry, "gateway", "install", "--force", ...port, "--json"],
    {
      cwd: params.staged,
      env: runtimeSlotEnv(params.node, params.env),
      timeoutMs: 120_000,
    },
  ).catch(() => null);
  return result?.code === 0;
}

async function restartGateway(
  env: NodeJS.ProcessEnv,
  port: number | undefined,
): Promise<"requested" | "service" | null> {
  try {
    await callGateway({
      method: "gateway.restart.request",
      params: { reason: "update" },
      deviceIdentity: null,
      timeoutMs: 10_000,
      ...(port ? { localPortOverride: port } : {}),
    });
    return "requested";
  } catch {
    // An unreachable Gateway may still have a stopped or wedged service.
  }
  const argv =
    process.platform === "darwin"
      ? [
          "launchctl",
          "kickstart",
          "-k",
          `gui/${process.getuid?.()}/${resolveGatewayLaunchAgentLabel(env.OPENCLAW_PROFILE)}`,
        ]
      : [
          "systemctl",
          "--user",
          "restart",
          `${resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE)}.service`,
        ];
  const result = await runCommandWithTimeout(argv, { timeoutMs: 30_000 }).catch(() => null);
  return result?.code === 0 ? "service" : null;
}

type SlotTarget =
  | { kind: "npm"; spec: string; version: string | null }
  | { kind: "git"; remote: string; ref: string; version: string | null };

async function resolveTarget(params: {
  git: boolean;
  channel: UpdateChannel;
  tag: string | null;
  timeoutMs: number;
}): Promise<SlotTarget> {
  if (!params.git) {
    const tag = params.tag ?? channelToNpmTag(params.channel);
    // A version or dist-tag names the openclaw package; any other spec is used as given.
    const spec = /^[\w.+-]+$/u.test(tag) ? `openclaw@${tag}` : tag;
    const { version } = await resolveTargetVersion(tag, params.timeoutMs).catch(() => ({
      version: null,
    }));
    return { kind: "npm", spec, version };
  }
  if (params.channel === "dev") {
    return { kind: "git", remote: "origin", ref: DEV_BRANCH, version: null };
  }
  const { version } = await resolveTargetVersion(channelToNpmTag(params.channel), params.timeoutMs);
  if (!version) {
    throw new Error(`Cannot resolve the ${params.channel} release for a git update.`);
  }
  return { kind: "git", remote: "origin", ref: `refs/tags/v${version}`, version };
}

async function readHead(root: string): Promise<string | null> {
  const result = await runCommandWithTimeout(["git", "-C", root, "rev-parse", "HEAD"], {
    timeoutMs: 30_000,
  }).catch(() => null);
  return result?.code === 0 ? result.stdout.trim() : null;
}

export type RuntimeSlotUpdateRequest = Pick<
  UpdateCommandOptions,
  "channel" | "tag" | "sha" | "timeout" | "yes" | "dryRun" | "restart"
> & {
  /** Gateway update run that the Gateway confirming the slot finishes. */
  runId?: string;
  /** The calling Gateway restarts itself after the flip (chat `/update`). */
  restartSelf?: () => void;
  log?: (line: string) => void;
};

export async function runRuntimeSlotUpdate(
  opts: RuntimeSlotUpdateRequest,
  install: { root: string; git: boolean },
): Promise<RuntimeSlotUpdateResult> {
  const { root, git } = install;
  const mode = git ? "git" : "npm";
  const log = opts.log ?? (() => {});
  const env = process.env;
  const dir = resolveRuntimeSlotsDir(env);
  const timeoutMs = parseUpdateTimeoutMs(opts.timeout) ?? DEFAULT_STAGE_TIMEOUT_MS;
  const requested = parseUpdateChannel(opts.channel);
  const snapshot = await readConfigFileSnapshot();
  const configured = parseUpdateChannel(snapshot.config.update?.channel ?? undefined);
  const channel = requested ?? configured ?? (git ? "dev" : "stable");
  const existing = readRuntimePointer(dir);
  const current = existing?.current ?? root;
  const before = await readPackageVersion(current);
  const serviceArgs = await readServiceArgs(env);
  const { node, port } = readServiceCommand(serviceArgs);
  const target = await resolveTarget({
    git,
    channel,
    tag: git ? null : normalizeTag(opts.tag),
    timeoutMs,
  });
  let source: RuntimeSlotSource;
  let unchanged: boolean;
  if (target.kind === "npm") {
    source = { kind: "npm", spec: target.spec };
    unchanged = !opts.tag && target.version !== null && target.version === before;
  } else {
    const sha = await fetchRuntimeSlotGitTarget({
      repo: root,
      remote: target.remote,
      ref: target.ref,
      ...(opts.sha ? { sha: opts.sha } : {}),
      node,
      env,
      timeoutMs,
    });
    source = { kind: "git", repo: root, sha };
    unchanged = sha === (await readHead(current));
  }
  const version = target.version;
  const refuse = (status: "error" | "skipped", reason: string, message: string) =>
    ({ status, mode, reason, before, after: version, message }) satisfies RuntimeSlotUpdateResult;
  if (version && before && (compareSemverStrings(version, before) ?? 0) < 0 && !opts.yes) {
    return refuse(
      "error",
      "downgrade",
      `${version} is older than ${before}. Rerun with --yes to install it.`,
    );
  }
  if (unchanged) {
    return refuse("skipped", "already-current", `Already on ${before}.`);
  }
  if (opts.dryRun) {
    const label = source.kind === "npm" ? source.spec : source.sha;
    const slot = selectInactiveSlot(dir, existing ?? { current: root, origin: root });
    return refuse(
      "skipped",
      "dry-run",
      `Would stage ${label} into ${slot} and restart the Gateway.`,
    );
  }
  if (requested) {
    await persistRequestedUpdateChannel({ configSnapshot: snapshot, requestedChannel: requested });
  }
  const packageRoot = (await resolveOpenClawPackageRoot({ moduleUrl: import.meta.url })) ?? root;
  const pointer = await ensureRuntimeSlots({ dir, origin: root, packageRoot });
  const release = await acquireRuntimeSlotsLock(dir);
  try {
    if (pointer.trial !== undefined && pointer.trial < RUNTIME_SLOT_TRIAL_STARTS) {
      log(
        `Warning: ${pointer.current} has not been confirmed by a Gateway start; it becomes the rollback target.`,
      );
    }
    const slot = selectInactiveSlot(dir, pointer);
    log(`Staging ${mode} update in ${slot} (Node ${node})`);
    const staged = await stageRuntimeSlot({
      slot,
      source,
      node,
      env,
      timeoutMs,
      onStep: (step) => log(`  ${step}`),
    });
    const reported = await smokeRuntimeSlot({
      root: staged,
      node,
      env,
      expectedVersion: version ?? undefined,
    });
    const after = await readPackageVersion(staged);
    log(`Staged ${reported}; selecting it.`);
    activateRuntimeSlot(dir, staged, opts.runId);
    log(`Selected ${staged}.`);
    const done = (
      status: RuntimeSlotUpdateResult["status"],
      restart: NonNullable<RuntimeSlotUpdateResult["restart"]>,
      message: string,
    ): RuntimeSlotUpdateResult => ({
      status,
      mode,
      ...(status === "error" ? { reason: "rolled-back" } : {}),
      before,
      after,
      slot: staged,
      restart,
      message,
    });
    if (opts.restart === false) {
      return done("ok", "next-start", "Update applies on the next Gateway start.");
    }
    if (await moveServiceToLauncher({ args: serviceArgs, port, dir, staged, node, env })) {
      log("Pointed the Gateway service at the runtime launcher and restarted it.");
    } else if (opts.restartSelf) {
      opts.restartSelf();
      return done("ok", "self", `Restarting the Gateway on ${after}.`);
    } else {
      const restart = await restartGateway(env, port);
      if (!restart) {
        return done(
          "ok",
          "next-start",
          "No running Gateway or service answered; the update applies on the next Gateway start.",
        );
      }
      log(
        restart === "requested"
          ? "Asked the Gateway to restart; waiting for it to confirm the new slot."
          : "Restarted the service; waiting for the Gateway to confirm the new slot.",
      );
    }
    const outcome = await waitForRuntimeSlotOutcome(dir, staged, DEFAULT_RESTART_WAIT_MS);
    return outcome === "rolled-back"
      ? done(
          "error",
          outcome,
          `The Gateway did not start on ${after}; the launcher returned to ${before}.`,
        )
      : done(
          "ok",
          outcome,
          outcome === "confirmed"
            ? `Gateway is running ${after}.`
            : `Restart requested; ${after} applies when the Gateway restarts.`,
        );
  } finally {
    await release();
  }
}

/** The npm dist-tag or version a package-manager command should install. */
export async function resolveUpdateTag(opts: Pick<UpdateCommandOptions, "channel" | "tag">) {
  const channel =
    parseUpdateChannel(opts.channel) ??
    parseUpdateChannel((await readConfigFileSnapshot()).config.update?.channel ?? undefined) ??
    "stable";
  return normalizeTag(opts.tag) ?? channelToNpmTag(channel);
}

/** `openclaw update`: runs before the in-place updater admits state or inspects services. */
export async function tryRunRuntimeSlotUpdate(opts: UpdateCommandOptions): Promise<boolean> {
  if (opts.run || opts.recovery || opts.sourceUpdate) {
    return false;
  }
  const owner = await resolveUpdateOwner(await resolveUpdateRoot(), await resolveUpdateTag(opts));
  if (owner.kind === "external") {
    // Not an error: the owning package manager is the update path.
    if (opts.json) {
      defaultRuntime.writeJson({ status: "skipped", reason: owner.reason, message: owner.message });
    } else {
      defaultRuntime.log(owner.message);
    }
    return true;
  }
  const install = owner;
  let result: RuntimeSlotUpdateResult;
  try {
    result = await runRuntimeSlotUpdate(
      { ...opts, log: (line) => !opts.json && defaultRuntime.log(line) },
      install,
    );
  } catch (error) {
    result = {
      status: "error",
      mode: install.git ? "git" : "npm",
      reason: "slot-update-failed",
      message: formatErrorMessage(error),
    };
  }
  if (opts.json) {
    defaultRuntime.writeJson(result);
  } else if (result.status === "error") {
    defaultRuntime.error(result.message);
  } else {
    defaultRuntime.log(result.message);
  }
  if (result.status === "error") {
    exitCliAfterOutput(defaultRuntime, 1);
  }
  return true;
}
