/** Doctor repair for a user-scope leftover that duels a system gateway unit. */
import { note } from "../../packages/terminal-core/src/note.js";
import { renderGatewayServiceCleanupHints } from "../daemon/inspect.js";
import {
  findSystemdGatewayInstallation,
  isSystemUnitActiveAndEnabled,
  uninstallUserSystemdGatewayUnit,
} from "../daemon/systemd.js";
import type { RuntimeEnv } from "../runtime.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import {
  confirmDoctorServiceRepair,
  formatServiceRepairDeferredNote,
  isServiceRepairDeferred,
  resolveServiceRepairPolicy,
} from "./doctor-service-repair-policy.js";

// Canonical units are excluded from findExtraGatewayServices. Inspect both scopes
// directly, and remove only a redundant user unit after verifying the system owner.
export async function maybeResolveDuelingSystemdGatewayScopes(
  runtime: RuntimeEnv,
  prompter: DoctorPrompter,
) {
  if (process.platform !== "linux") {
    return;
  }
  const installation = await findSystemdGatewayInstallation(process.env).catch(() => {
    note(
      "Could not verify the effective Gateway service identities. Nothing was removed; inspect both units with openclaw gateway status --deep.",
      "Gateway cleanup needs an owner decision",
    );
    return null;
  });
  if (installation?.kind !== "dueling") {
    return;
  }
  const { user, system } = installation;
  note(
    [
      "Both a user-scope and a system-scope OpenClaw gateway unit are installed:",
      `- user:   ${user.unitPath}`,
      `- system: ${system.unitPath}`,
      "They bind the same port and will SIGTERM each other in a restart loop.",
    ].join("\n"),
    "Dueling gateway services detected",
  );

  // A staged, disabled, failed, or uncheckable system unit cannot replace a working user Gateway.
  const systemOwnsGateway = await isSystemUnitActiveAndEnabled(process.env, system.unitName).catch(
    () => false,
  );
  if (!systemOwnsGateway) {
    note(
      [
        "Could not verify the system-scope unit is both running and enabled at boot, so the",
        "user-scope unit may be your working gateway. Not removing anything",
        "automatically.",
        "If the system-scope unit is the one you want, activate it and re-run doctor:",
        `- sudo systemctl enable --now ${system.unitName}`,
        "If the user-scope unit is the one you want, remove the system unit:",
        `- sudo systemctl disable --now ${system.unitName} && sudo rm ${system.unitPath}`,
      ].join("\n"),
      "Gateway cleanup needs an owner decision",
    );
    return;
  }
  note(
    [
      "The system-scope unit is the active and boot-enabled supervisor and is",
      "treated as authoritative; the user-scope unit is the redundant leftover.",
    ].join("\n"),
    "System-scope unit owns the gateway",
  );

  const policy = resolveServiceRepairPolicy();
  if (isServiceRepairDeferred(policy)) {
    note(formatServiceRepairDeferredNote(), "Gateway cleanup skipped");
    return;
  }

  const shouldRemove = await confirmDoctorServiceRepair(
    prompter,
    {
      message: "Remove the redundant user-scope gateway unit and keep the system-scope unit?",
      initialValue: true,
    },
    policy,
  );
  if (!shouldRemove) {
    const hints = renderGatewayServiceCleanupHints();
    if (hints.length > 0) {
      note(hints.map((hint) => `- ${hint}`).join("\n"), "Cleanup hints");
    }
    return;
  }

  const current = await findSystemdGatewayInstallation(process.env).catch(() => null);
  if (
    current?.kind !== "dueling" ||
    current.user.unitName !== user.unitName ||
    current.user.unitPath !== user.unitPath ||
    current.system.unitName !== system.unitName ||
    current.system.unitPath !== system.unitPath ||
    !(await isSystemUnitActiveAndEnabled(process.env, system.unitName).catch(() => false))
  ) {
    note(
      "Gateway service ownership changed or could not be verified after confirmation. Nothing was removed; inspect both units and run Doctor again.",
      "Gateway cleanup needs an owner decision",
    );
    return;
  }

  const result = await uninstallUserSystemdGatewayUnit({
    env: process.env,
    stdout: process.stdout,
    target: user,
  }).catch((err: unknown) => {
    runtime.error(`Failed to remove redundant user-scope gateway unit: ${String(err)}`);
    const hints = renderGatewayServiceCleanupHints();
    if (hints.length > 0) {
      note(hints.map((hint) => `- ${hint}`).join("\n"), "Cleanup hints");
    }
    return null;
  });
  if (!result) {
    return;
  }
  note(
    result.removed
      ? `Removed user-scope unit ${result.unitPath}.`
      : `User-scope unit already absent at ${result.unitPath}.`,
    "Redundant user gateway removed",
  );
  if (!result.disabled) {
    runtime.log(
      `Removed the user-scope unit file, but systemctl was unavailable to stop it. Run: systemctl --user disable --now ${result.unitName} && systemctl --user daemon-reload`,
    );
    return;
  }

  // Removing the confirmed unit does not authorize cleanup of another alias.
  const remaining = await findSystemdGatewayInstallation(process.env, {
    requireLoaded: true,
  }).catch(() => null);
  const completed = `Cleanup of ${result.unitName} completed.`;
  if (remaining?.kind === "user" || remaining?.kind === "dueling") {
    runtime.log(
      `${completed} Another user-scope unit remains at ${remaining.user.unitPath}. It was not removed. Run openclaw doctor again to inspect it before removal.`,
    );
  } else if (
    remaining?.kind === "system" &&
    remaining.system.unitName === system.unitName &&
    remaining.system.unitPath === system.unitPath
  ) {
    runtime.log(`${completed} No other matching installed user-scope unit was found.`);
  } else {
    runtime.log(
      `${completed} Remaining service ownership could not be verified. Run openclaw gateway status --deep and openclaw doctor before any further cleanup.`,
    );
  }
}
