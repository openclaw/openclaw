import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import type { DraftEnvironment } from "./discovery.ts";
import { environmentMenuFacts, MAX_PLACE_MENU_FACTS } from "./place-facts.ts";
import { disambiguate } from "./place-labels.ts";

registerNewSessionSetupEnglish();

export type DevicePlacementOption = Readonly<
  {
    deviceId: string;
    label: string;
    subtitle?: string;
    hideDetails?: boolean;
    remediation?: "enable-session-hosting" | "update-device";
    facts: readonly string[];
    selectable: boolean;
    disabledReason?: string;
  } & Pick<DraftEnvironment, "platform" | "workerSlots" | "capabilities" | "invocableCommands">
>;

export type DevicePlacementRequirement = Readonly<{
  requiredNodeCommands: readonly string[];
  consumesWorkerSlot: boolean;
}>;

/** Session-scoped placement blockers that apply to every paired-device row. */
export type SessionPlacementBlockerCode =
  | "runtime-unsupported"
  | "workspace-symlinks"
  | "prepared-auth";

export type SessionPlacementBlocker = Readonly<{
  code: SessionPlacementBlockerCode;
  message: string;
}>;

const DEFAULT_DEVICE_PLACEMENT: DevicePlacementRequirement = {
  requiredNodeCommands: [],
  consumesWorkerSlot: true,
};

/** Join complete-sentence disqualifiers without inventing a new grammar. */
export function stackDisabledReasons(reasons: readonly (string | undefined)[]): string | undefined {
  const unique: string[] = [];
  for (const reason of reasons) {
    const trimmed = reason?.trim();
    if (!trimmed) {
      continue;
    }
    if (!unique.some((existing) => existing === trimmed)) {
      unique.push(trimmed);
    }
  }
  return unique.length > 0 ? unique.join(" ") : undefined;
}

/**
 * Builds session-level blockers for the shared picker.
 * Workspace symlink portability and prepared OpenAI auth are session facts:
 * when callers know them (preflight / draft), every device row hard-disables
 * with those accurate reasons instead of looking hostable until dispatch fails.
 */
export function buildSessionPlacementBlockers(params: {
  runtimeUnsupportedReason?: string;
  workspaceHasEscapingSymlinks?: boolean;
  missingPreparedAuth?: boolean;
}): SessionPlacementBlocker[] {
  const blockers: SessionPlacementBlocker[] = [];
  const runtimeReason = params.runtimeUnsupportedReason?.trim();
  if (runtimeReason) {
    blockers.push({ code: "runtime-unsupported", message: runtimeReason });
  }
  if (params.workspaceHasEscapingSymlinks) {
    blockers.push({
      code: "workspace-symlinks",
      message: t("newSession.workspaceSymlinksBlockPlacement"),
    });
  }
  if (params.missingPreparedAuth) {
    blockers.push({
      code: "prepared-auth",
      message: t("newSession.preparedAuthBlockPlacement"),
    });
  }
  return blockers;
}

export function sessionPlacementDisabledReason(
  blockers: readonly SessionPlacementBlocker[],
): string | undefined {
  return stackDisabledReasons(blockers.map((blocker) => blocker.message));
}

function collectUnavailableReasons(
  environment: DraftEnvironment,
  requirement: DevicePlacementRequirement,
): string[] {
  const reasons: string[] = [];
  const updateIssue = environment.issues?.find((issue) => issue.code === "update-required");
  if (updateIssue) {
    // Update-required owns reconnect remediation; further inventory checks are stale.
    return [
      t("newSession.nodeUpdateRequired", {
        updateCommand: updateIssue.updateCommand,
        restartCommand: updateIssue.headlessReconnectCommand,
      }),
    ];
  }
  if (environment.status !== "available") {
    // Offline rows cannot host; capacity and command authority are reconnect-scoped.
    return [t("newSession.deviceUnavailable")];
  }
  if (environment.sessionHost !== true) {
    reasons.push(t("newSession.sessionHostingDisabled"));
  }
  if (requirement.requiredNodeCommands.length > 0) {
    const requiredCommand = environment.requiredNodeCommand;
    if (!requiredCommand) {
      reasons.push(t("newSession.placementNotReady"));
    } else if (requiredCommand.state === "pending-approval") {
      reasons.push(
        t("newSession.nodeCommandPendingApproval", { command: requiredCommand.command }),
      );
    } else if (requiredCommand.state === "undeclared") {
      reasons.push(t("newSession.nodeCommandUndeclared", { command: requiredCommand.command }));
    } else if (requiredCommand.state === "unauthorized") {
      reasons.push(t("newSession.nodeCommandUnauthorized", { command: requiredCommand.command }));
    }
  }
  // Capacity only applies to session hosts; non-hosts already surface hosting remediation.
  if (environment.sessionHost === true && requirement.consumesWorkerSlot) {
    if (!environment.workerSlots) {
      reasons.push(t("newSession.deviceCapacityUnavailable"));
    } else if (environment.workerSlots.available === 0) {
      reasons.push(t("newSession.deviceNoSlots"));
    }
  }
  return reasons;
}

function unavailableReason(
  environment: DraftEnvironment,
  requirement: DevicePlacementRequirement,
): string | undefined {
  return stackDisabledReasons(collectUnavailableReasons(environment, requirement));
}

/** One projection owns device presentation, restore eligibility, and submit eligibility. */
export function projectDevicePlacements(
  environments: readonly DraftEnvironment[] | null,
  requirement: DevicePlacementRequirement = DEFAULT_DEVICE_PLACEMENT,
  placementDisabledReason?: string,
): DevicePlacementOption[] {
  const devices = (environments ?? [])
    .flatMap<DevicePlacementOption>((environment) => {
      if (environment.type !== "node" || !environment.id.startsWith("node:")) {
        return [];
      }
      const deviceId = environment.id.slice("node:".length).trim();
      if (!deviceId) {
        return [];
      }
      // Session blockers hard-disable every row; still surface stacked device
      // inventory disqualifiers so operators see the full binding reason.
      const disabledReason = stackDisabledReasons([
        placementDisabledReason,
        environment.disabledReason,
        unavailableReason(environment, requirement),
      ]);
      const facts = environmentMenuFacts(environment, {
        connected: environment.status === "available",
      });
      const priorityFacts =
        (environment.issues?.length ?? 0) > 0 || environment.status !== "available" ? 1 : 0;
      const visibleFacts =
        disabledReason && !facts.includes(disabledReason)
          ? [...facts.slice(0, priorityFacts), disabledReason, ...facts.slice(priorityFacts)].slice(
              0,
              MAX_PLACE_MENU_FACTS,
            )
          : facts;
      return [
        {
          deviceId,
          label: environment.label ?? deviceId,
          platform: environment.platform,
          hideDetails:
            !placementDisabledReason &&
            environment.status === "unavailable" &&
            !environment.issues?.length,
          remediation: placementDisabledReason
            ? undefined
            : environment.issues?.some((issue) => issue.code === "update-required")
              ? "update-device"
              : environment.status === "available" && environment.sessionHost !== true
                ? "enable-session-hosting"
                : undefined,
          facts: placementDisabledReason
            ? [disabledReason ?? placementDisabledReason]
            : visibleFacts,
          workerSlots: environment.workerSlots,
          capabilities: environment.capabilities,
          invocableCommands: environment.invocableCommands,
          selectable: disabledReason === undefined,
          ...(disabledReason ? { disabledReason } : {}),
        },
      ];
    })
    .toSorted(
      (left, right) =>
        left.label.localeCompare(right.label) || left.deviceId.localeCompare(right.deviceId),
    );
  const subtitles = disambiguate(devices, (device) => device.label, [
    (device) => device.deviceId.slice(0, 8),
  ]);
  const projected: DevicePlacementOption[] = [];
  for (const [index, device] of devices.entries()) {
    const subtitle = subtitles[index];
    projected.push(subtitle ? { ...device, subtitle } : device);
  }
  return projected;
}

export function resolveAutomaticDevicePlacementDisabledReason(
  environments: readonly DraftEnvironment[] | null,
  devices: readonly DevicePlacementOption[],
  runtimeDisabledReason?: string,
): string | undefined {
  if (runtimeDisabledReason) {
    return runtimeDisabledReason;
  }
  const sessionHostIds = new Set(
    (environments ?? [])
      .filter((environment) => environment.type === "node" && environment.sessionHost === true)
      .map((environment) => environment.id),
  );
  if (sessionHostIds.size === 0) {
    const outdated = (environments ?? []).find((environment) =>
      environment.issues?.some((issue) => issue.code === "update-required"),
    );
    return outdated
      ? unavailableReason(outdated, DEFAULT_DEVICE_PLACEMENT)
      : t("newSession.noSessionHosts");
  }
  return devices.some((device) => device.selectable)
    ? undefined
    : devices.find((device) => sessionHostIds.has(`node:${device.deviceId}`))?.disabledReason;
}
