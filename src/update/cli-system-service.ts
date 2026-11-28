import path from "node:path";
import { satisfies } from "semver";
import {
  assertGlobalUpdateOwner,
  normalizeTag,
  parseUpdateChannel,
  parseUpdateTimeoutMs,
  requestUpdateDowngradeConfirmation,
  runUpdateStep,
  type UpdateCommandOptions,
} from "../cli/update-cli/shared.js";
import { isBunRuntime, isNodeRuntime } from "../daemon/runtime-binary.js";
import type { SystemdServiceAccountMismatch } from "../daemon/service-inspection-error.js";
import { execSystemctl } from "../daemon/systemd-exec.js";
import {
  findRootOwnedRunuser,
  resolveServiceAccountName,
  serviceAccountArgv,
} from "../daemon/systemd-service-account-command.js";
import { formatErrorMessage } from "../infra/errors.js";
import { compareSemverStrings } from "../infra/npm-registry-spec.js";
import { runGlobalPackageUpdateSteps } from "../infra/package-update-steps.js";
import { isSupportedBunVersion } from "../infra/runtime-guard.js";
import { resolveEffectiveUpdateChannel } from "../infra/update-channels.js";
import { fetchNpmPackageTargetStatus } from "../infra/update-check-package-target.js";
import {
  createGlobalInstallEnv,
  detectGlobalInstallManagerForRoot,
  resolveGlobalInstallTarget,
} from "../infra/update-global.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { defaultRuntime } from "../runtime.js";
import { VERSION } from "../version.js";
import { PREPARE_DEADLINE_MS } from "./run.js";
import { resolveTarget } from "./target.js";

/** The identified system unit owns boot and state; root replaces only its package. */
export async function updateSystemServicePackage(
  opts: UpdateCommandOptions,
  root: string,
  unit: SystemdServiceAccountMismatch,
): Promise<void> {
  const deadline = Date.now() + (parseUpdateTimeoutMs(opts.timeout) ?? PREPARE_DEADLINE_MS);
  const remaining = () => {
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) {
      throw new Error("System-service update timed out.");
    }
    return timeoutMs;
  };
  const channel = parseUpdateChannel(opts.channel);
  if (
    opts.sha ||
    opts.reapplyLocalOverrides ||
    opts.fullIntegrityCheck ||
    opts.acceptCapabilities
  ) {
    throw new Error(
      "This system-service update replaces only the package. Run state maintenance and capability approval as the service account; Git SHAs and local override replay are not supported here.",
    );
  }
  const manager = await detectGlobalInstallManagerForRoot(runCommandWithTimeout, root, remaining());
  if (!manager) {
    throw new Error(
      "The system service's package manager could not be identified. Nothing changed.",
    );
  }
  const installTarget = await resolveGlobalInstallTarget({
    manager,
    pkgRoot: root,
    honorPackageRoot: true,
    runCommand: runCommandWithTimeout,
    timeoutMs: remaining(),
  });
  await assertGlobalUpdateOwner({ root, installKind: "package", timeoutMs: remaining() });
  const target = await resolveTarget({
    kind: "package",
    channel: resolveEffectiveUpdateChannel({
      configChannel: channel,
      currentVersion: VERSION,
      installKind: "package",
    }).channel,
    tag: normalizeTag(opts.tag) ?? undefined,
    timeoutMs: remaining(),
  });
  if (target.kind !== "package") {
    throw new Error("A system-service package update requires a package target.");
  }
  const nodeEngine =
    target.engines?.node ??
    (await fetchNpmPackageTargetStatus({ target: target.version, timeoutMs: remaining() }))
      .nodeEngine;
  if (!nodeEngine) {
    throw new Error("Could not read the target's Node requirements. The package was not changed.");
  }
  if (!opts.yes && (compareSemverStrings(VERSION, target.version) ?? 0) > 0) {
    const decision = await requestUpdateDowngradeConfirmation({
      json: Boolean(opts.json),
      currentVersion: VERSION,
      targetVersion: target.version,
      tag: opts.tag ?? target.version,
    });
    if (decision !== "confirmed") {
      throw new Error("Downgrade not confirmed. Nothing changed.");
    }
  }
  const executable = unit.programArguments[0] ?? "";
  const bun = isBunRuntime(executable);
  const nextStep = `Select a compatible runtime in ${unit.unitName}'s ExecStart and ensure it can run as ${unit.serviceUser}, then retry. The package was not changed.`;
  const runuser = await findRootOwnedRunuser();
  if (!runuser) {
    throw new Error(
      "No root-owned runuser was found. Install util-linux's runuser and retry. The package was not changed.",
    );
  }
  if (!path.isAbsolute(executable) || (!bun && !isNodeRuntime(executable))) {
    throw new Error(
      `The recorded executable ${JSON.stringify(executable)} is not an absolute Node/Bun runtime. ${nextStep}`,
    );
  }
  const account = await resolveServiceAccountName(unit.serviceUser).catch((cause: unknown) => {
    throw new Error(`Service account lookup failed: ${formatErrorMessage(cause)}. ${nextStep}`, {
      cause,
    });
  });
  // Never execute a service-account-owned runtime or its loader environment as root.
  const probe = await runCommandWithTimeout(
    serviceAccountArgv({ runuser, account, argv: [executable, "--version"] }),
    {
      baseEnv: {},
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
      cwd: "/",
      timeoutMs: Math.min(remaining(), 10_000),
      killProcessTree: true,
    },
  ).catch((cause: unknown) => {
    throw new Error(`Service runtime check failed: ${formatErrorMessage(cause)}. ${nextStep}`, {
      cause,
    });
  });
  if (probe.code !== 0) {
    throw new Error(
      `Service runtime check failed: ${probe.stderr.trim() || probe.stdout.trim() || `exit ${probe.code}`}. ${nextStep}`,
    );
  }
  const version = probe.stdout.trim();
  if (
    (bun && !isSupportedBunVersion(version)) ||
    (!bun && !satisfies(version, nodeEngine, { includePrerelease: true }))
  ) {
    throw new Error(
      `Service runtime ${version} cannot run this package (${bun ? "supported Bun required" : `Node ${nodeEngine} required`}). ${nextStep}`,
    );
  }
  const env = await createGlobalInstallEnv(
    {
      ...process.env,
      OPENCLAW_UPDATE_RUN_ID: undefined,
      OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
    },
    installTarget,
  );
  const installed = await runGlobalPackageUpdateSteps({
    installTarget,
    installSpec: target.spec,
    packageName: "openclaw",
    packageRoot: root,
    runCommand: (argv, options) =>
      runCommandWithTimeout(argv, {
        ...(typeof options === "number" ? {} : options),
        timeoutMs: Math.min(remaining(), typeof options === "number" ? options : options.timeoutMs),
      }),
    runStep: (step) =>
      runUpdateStep({
        ...step,
        timeoutMs:
          step.timeoutMs === undefined ? remaining() : Math.min(step.timeoutMs, remaining()),
      }),
    timeoutMs: remaining(),
    workTimeoutMs: remaining(),
    env,
    resolveLifecycleNodeRunner: () => process.execPath,
  });
  if (installed.failedStep) {
    throw new Error(
      installed.failedStep.stderrTail ?? `Package update failed: ${installed.failedStep.name}`,
    );
  }
  const checks = `systemctl status ${unit.unitName}; journalctl -u ${unit.unitName}`;
  let message = `Package ${installed.afterVersion ?? target.version} installed. State convergence belongs to ${unit.serviceUser}'s service boot.`;
  if (opts.restart !== false) {
    try {
      // systemctl waits for the stop/start job; RestartUnit alone only queues it.
      const restarted = await execSystemctl(
        ["--system", "restart", unit.unitName],
        process.env,
        remaining(),
      );
      if (restarted.code !== 0) {
        throw new Error(restarted.stderr || restarted.stdout || "systemctl restart failed");
      }
    } catch (cause) {
      throw new Error(
        `Package installed, but ${unit.unitName} could not restart. Check: ${checks}`,
        {
          cause,
        },
      );
    }
    const active = await execSystemctl(
      ["--system", "is-active", "--quiet", unit.unitName],
      process.env,
      remaining(),
    );
    if (active.code !== 0) {
      throw new Error(`Package installed, but ${unit.unitName} is not active. Check: ${checks}`);
    }
    // Port alone cannot identify HTTP versus configured TLS without opening service state.
    message += " Unit active; readiness not verified.";
  } else {
    message += ` Restart with: systemctl restart ${unit.unitName}.`;
  }
  message += ` Check: ${checks}`;
  if (opts.json) {
    defaultRuntime.writeJson({
      status: "ok",
      after: { version: installed.afterVersion ?? target.version },
      message,
    });
  } else {
    defaultRuntime.log(message);
  }
  process.exitCode = 0;
}
