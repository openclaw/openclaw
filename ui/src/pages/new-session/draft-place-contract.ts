import type { ApplicationContext } from "../../app/context.ts";
import type { NewSessionRouteData } from "./location.ts";
import type { NewSessionModelSelection } from "./model-selection.ts";

export type DraftCloudProfileSelection = {
  readonly modelControl: NewSessionModelSelection;
  readonly requiredPlacement: boolean;
  isAdmin(): boolean;
  selectCloudProfile(profileId: string): void;
};

export type DraftPlaceSnapshot = Readonly<{
  context: ApplicationContext | undefined;
  data: NewSessionRouteData | undefined;
  submitting: boolean;
  pendingPlacementSessionKey: string;
}>;

export type DraftPlaceCallbacks = {
  changed: () => void;
  onError: (error: string | null) => void;
  onClearError: (error: string) => void;
};
