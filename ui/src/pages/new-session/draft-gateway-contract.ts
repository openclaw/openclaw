import type { ApplicationContext } from "../../app/context.ts";
import type { NewSessionRouteData } from "./location.ts";
import type { PaletteSessionPreference } from "./preferences.ts";
import type { SubmissionOutcomeReason } from "./session-placement-recovery-state.ts";

export type DraftGatewaySnapshot = Readonly<{
  context: ApplicationContext | undefined;
  data: NewSessionRouteData | undefined;
  isConnected: boolean;
  isAdmin: boolean;
  canStartAsDraft: boolean;
  visibility: "normal" | "draft" | "incognito";
  cloudProfileId: string;
  pendingPlacement: Readonly<{
    sessionKey: string;
    gatewayUrl: string;
    recoveryScope: string;
  }>;
  agentsHydrated: boolean;
  runtimeId: string;
}>;

export type DraftPreferenceOptions = {
  preferenceScope?: "palette";
  readPalettePreference?: () => PaletteSessionPreference | null;
};

export type DraftGatewayCallbacks = DraftPreferenceOptions & {
  // Read apart from the snapshot: the snapshot's place fields depend on this policy.
  readAgents: () => ApplicationContext["agents"] | undefined;
  requestUpdate: () => void;
  updateComplete: () => Promise<unknown>;
  onInvalidate: (resetHostSelection: boolean, outcome: SubmissionOutcomeReason) => void;
  onVisibilityRetired: () => void;
  onCloudProfileCleared: () => void;
  onCloudState: (error: string | null) => void;
  onPendingPlacementReset: () => void;
  onRecoveryReady: (gatewayUrl: string, recoveryScope: string) => void;
  onAdoptAgentDefaults: () => void;
};
