import {
  assertGlobalUpdateOwner,
  parseUpdateChannel,
  parseUpdateTimeoutMs,
  requestUpdateDowngradeConfirmation,
  runUpdateStep,
  type UpdateCommandOptions,
} from "../cli/update-cli/shared.js";
import type { SystemdServiceAccountMismatch } from "../daemon/service-inspection-error.js";
import { execSystemctl } from "../daemon/systemd-exec.js";
import { restartSystemdService } from "../daemon/systemd-lifecycle.js";
import { captureSystemdServiceIdentity } from "../daemon/systemd-service-identity.js";
import { compareSemverStrings } from "../infra/npm-registry-spec.js";
import { runGlobalPackageUpdateSteps } from "../infra/package-update-steps.js";
import { resolveEffectiveUpdateChannel } from "../infra/update-channels.js";
import {
  createGlobalInstallEnv,
  detectGlobalInstallManagerForRoot,
  resolveGlobalInstallTarget,
} from "../infra/update-global.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { defaultRuntime } from "../runtime.js";
import { createNullWriter } from "../shared/null-writer.js";
import { VERSION } from "../version.js";
import { PREPARE_DEADLINE_MS } from "./run.js";
import { resolveTarget } from "./target.js";

/** The identified system unit owns boot and state; root replaces only its package. */
export async function updateSystemServicePackage(
  opts: UpdateCommandOptions,
  root: string,
  unit: SystemdServiceAccountMismatch,
): Promise<void> {
  const timeoutMs = parseUpdateTimeoutMs(opts.timeout) ?? PREPARE_DEADLINE_MS;
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
  const manager = await detectGlobalInstallManagerForRoot(runCommandWithTimeout, root, timeoutMs);
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
    timeoutMs,
  });
  await assertGlobalUpdateOwner({ root, installKind: "package", timeoutMs });
  const target = await resolveTarget({
    kind: "package",
    channel: resolveEffectiveUpdateChannel({
      configChannel: channel,
      currentVersion: VERSION,
      installKind: "package",
    }).channel,
    tag: opts.tag,
    timeoutMs,
  });
  if (target.kind !== "package") {
    throw new Error("A system-service package update requires a package target.");
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
  const selected = await captureSystemdServiceIdentity({
    env: process.env,
    target: { scope: "system", unitName: unit.unitName, unitPath: unit.unitPath },
    rootServiceAccount: unit.serviceUser,
    timeoutMs,
  });
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
    runCommand: runCommandWithTimeout,
    runStep: runUpdateStep,
    timeoutMs,
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
      await restartSystemdService({
        env: process.env,
        systemdIdentity: selected,
        stdout: createNullWriter(),
      });
    } catch (cause) {
      throw new Error(
        `Package installed, but ${unit.unitName} could not restart. Check: ${checks}`,
        {
          cause,
        },
      );
    }
    const active = await execSystemctl(
      ["is-active", "--quiet", unit.unitName],
      process.env,
      timeoutMs,
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
