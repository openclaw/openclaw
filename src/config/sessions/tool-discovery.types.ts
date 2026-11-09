import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { USER_PROFILE_ID_MAX_LENGTH } from "../../../packages/gateway-protocol/src/schema/user-profile-constants.js";

export const SESSION_TOOL_DISCOVERY_SESSION_ID_MAX_LENGTH = 512;

/** Passive model-facing presentation; none of these facts grants execution authority. */
export type SessionToolDiscoveryPresentation = {
  workshop?: { defaultTarget: "workspace" | "personal"; multipleProfiles: boolean };
  automations?: "ordinary" | "management";
};

/** Kept by the existing session owner, never returned through public session projections. */
export type SessionToolDiscovery = {
  version: 1;
  sessionId: string;
  profileId: string;
  profileFactsKey: string;
  audienceKey: string;
  presentation: SessionToolDiscoveryPresentation;
};

/** Fresh human ingress may replace discovery; continuations never reconstruct this capture. */
export type SessionToolDiscoveryCapture = (
  | { kind: "clear" }
  | {
      kind: "profile";
      profileId: string;
      profileFactsKey: string;
      presentation: SessionToolDiscoveryPresentation;
    }
) & { assertCurrent: () => void };
/** Admit persisted/imported presentation once; older or malformed records stay undiscovered. */
export function normalizeSessionToolDiscovery(value: unknown): SessionToolDiscovery | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.sessionId !== "string" ||
    value.sessionId.length === 0 ||
    value.sessionId.length > SESSION_TOOL_DISCOVERY_SESSION_ID_MAX_LENGTH ||
    typeof value.profileId !== "string" ||
    value.profileId.length === 0 ||
    value.profileId.length > USER_PROFILE_ID_MAX_LENGTH ||
    typeof value.profileFactsKey !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.profileFactsKey) ||
    typeof value.audienceKey !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.audienceKey) ||
    !isRecord(value.presentation)
  ) {
    return undefined;
  }
  const { workshop, automations } = value.presentation;
  if (
    (workshop !== undefined &&
      (!isRecord(workshop) ||
        (workshop.defaultTarget !== "personal" && workshop.defaultTarget !== "workspace") ||
        typeof workshop.multipleProfiles !== "boolean")) ||
    (automations !== undefined && automations !== "ordinary" && automations !== "management")
  ) {
    return undefined;
  }
  return {
    version: 1,
    sessionId: value.sessionId,
    profileId: value.profileId,
    profileFactsKey: value.profileFactsKey,
    audienceKey: value.audienceKey,
    presentation: {
      ...(isRecord(workshop) &&
      (workshop.defaultTarget === "personal" || workshop.defaultTarget === "workspace") &&
      typeof workshop.multipleProfiles === "boolean"
        ? {
            workshop: {
              defaultTarget: workshop.defaultTarget,
              multipleProfiles: workshop.multipleProfiles,
            },
          }
        : {}),
      ...(automations === "ordinary" || automations === "management" ? { automations } : {}),
    },
  };
}
