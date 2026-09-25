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

/**
 * Resolves a `dueling` systemd install (both a user-scope and a system-scope
 * gateway unit present) by removing the redundant user-scope unit after
 * confirmation, keeping the root-installed system-scope unit as authoritative.
 *
 * This is the fix for issue #79375: on Linux the two units bind the same port
 * and SIGTERM each other in an endless restart loop. The canonical units are
 * deliberately excluded from `findExtraGatewayServices`, so this detects the
 * condition directly via `findSystemdGatewayInstallation`. Removing a unit
 * under `$HOME` needs no root; the system-scope unit is never auto-removed
 * (only a `sudo`-flavored hint is offered for that direction).
 */
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

  // Ownership guard: delete the user unit only when the system unit is the
  // live or boot-configured supervisor. A staged/disabled/failed/uncheckable
  // system unit file with a working user gateway must fail closed to hints,
  // or doctor would take down the operator's only running gateway.
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

  try {
    const result = await uninstallUserSystemdGatewayUnit({
      env: process.env,
      stdout: process.stdout,
      target: user,
    });
    note(
      result.removed
        ? `Removed user-scope unit ${result.unitPath}.`
        : `User-scope unit already absent at ${result.unitPath}.`,
      "Redundant user gateway removed",
    );
    // Only claim the conflict is resolved when systemd actually released the
    // unit; a file-only removal can leave the loaded unit running.
    runtime.log(
      result.disabled
        ? "Removed the redundant user-scope gateway unit. The system-scope unit is now the sole gateway manager."
        : `Removed the user-scope unit file, but systemctl was unavailable to stop it. Run: systemctl --user disable --now ${result.unitName} && systemctl --user daemon-reload`,
    );
  } catch (err) {
    runtime.error(`Failed to remove redundant user-scope gateway unit: ${String(err)}`);
    const hints = renderGatewayServiceCleanupHints();
    if (hints.length > 0) {
      note(hints.map((hint) => `- ${hint}`).join("\n"), "Cleanup hints");
    }
  }
}
