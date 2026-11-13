// `openclaw update` for user-owned npm and git installs on Linux and macOS:
// stage the inactive runtime slot, prove it starts, flip slots.json, and ask the
// Gateway to exit so its supervisor starts the new slot through the launcher.
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
import { formatErrorMessage } from "../../infra/errors.js";
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
  selectInactiveSlot,
  smokeRuntimeSlot,
  stageRuntimeSlot,
  waitForRuntimeSlotOutcome,
  type RuntimeSlotOutcome,
  type RuntimeSlotSource,
} from "../../infra/runtime-slots.js";
import { channelToNpmTag, DEV_BRANCH, type UpdateChannel } from "../../infra/update-channels.js";
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

const SLOT_PLATFORMS = new Set<NodeJS.Platform>(["linux", "darwin"]);
const DEFAULT_STAGE_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_RESTART_WAIT_MS = 180_000;

type SlotUpdateResult = {
  status: "ok" | "skipped" | "error";
  mode: "npm" | "git";
  reason?: string;
  before?: string | null;
  after?: string | null;
  slot?: string;
  restart?: RuntimeSlotOutcome | "next-start";
  message: string;
};

/** The Node the installed service runs. Commands never rely on PATH to find it. */
async function resolveServiceNode(env: NodeJS.ProcessEnv): Promise<string> {
  const args =
    process.platform === "darwin"
      ? (
          await readLaunchAgentProgramArgumentsFromFile(resolveLaunchAgentPlistPath(env)).catch(
            () => null,
          )
        )?.programArguments
      : await fs
          .readFile(resolveSystemdUnitPath(env), "utf8")
          .then((unit) => {
            const line = unit.split("\n").find((entry) => entry.startsWith("ExecStart="));
            return line ? parseSystemdExecStart(line.slice("ExecStart=".length)) : undefined;
          })
          .catch(() => undefined);
  const node = args?.find(
    (arg) => path.isAbsolute(arg) && /^node(?:\.exe)?$/u.test(path.basename(arg)),
  );
  return node ?? process.execPath;
}

async function restartGateway(env: NodeJS.ProcessEnv): Promise<"requested" | "service" | null> {
  try {
    await callGateway({
      method: "gateway.restart.request",
      params: { reason: "update" },
      deviceIdentity: null,
      timeoutMs: 10_000,
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

async function runSlotUpdate(
  opts: UpdateCommandOptions,
  root: string,
  git: boolean,
): Promise<SlotUpdateResult> {
  const mode = git ? "git" : "npm";
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
  const node = await resolveServiceNode(env);
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
      node,
      env,
      timeoutMs,
    });
    source = { kind: "git", repo: root, sha };
    unchanged = sha === (await readHead(current));
  }
  const version = target.version;
  const refuse = (status: "error" | "skipped", reason: string, message: string) =>
    ({ status, mode, reason, before, after: version, message }) satisfies SlotUpdateResult;
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
    if (pointer.trial !== undefined) {
      defaultRuntime.error(
        `Warning: ${pointer.current} has not been confirmed by a Gateway start; it becomes the rollback target.`,
      );
    }
    const slot = selectInactiveSlot(dir, pointer);
    const log = (line: string) => !opts.json && defaultRuntime.log(line);
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
    activateRuntimeSlot(dir, staged);
    log(`Selected ${staged}.`);
    const done = (
      status: SlotUpdateResult["status"],
      restart: NonNullable<SlotUpdateResult["restart"]>,
      message: string,
    ): SlotUpdateResult => ({
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
    const restart = await restartGateway(env);
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

/** Dispatch before the in-place updater admits state, retains runtime, or inspects services. */
export async function tryRunRuntimeSlotUpdate(opts: UpdateCommandOptions): Promise<boolean> {
  if (
    !SLOT_PLATFORMS.has(process.platform) ||
    process.versions.bun ||
    opts.run ||
    opts.recovery ||
    opts.sourceUpdate
  ) {
    return false;
  }
  const root = await resolveUpdateRoot();
  const git = await isGitCheckout(root);
  const dir = resolveRuntimeSlotsDir();
  const onSlots = isPathInside(dir, root) || readRuntimePointer(dir) !== null;
  if (
    !onSlots &&
    !git &&
    (!root.split(path.sep).includes("node_modules") || (await resolveBrewOpenClawPath(root)))
  ) {
    return false;
  }
  let result: SlotUpdateResult;
  try {
    result = await runSlotUpdate(opts, root, git);
  } catch (error) {
    result = {
      status: "error",
      mode: git ? "git" : "npm",
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
