import type { NewSessionVisibility } from "./create-params.ts";

export type NewSessionVisibilityControl = {
  visibility: NewSessionVisibility;
  submitting: boolean;
  pendingPlacement: { sessionKey: string };
  incognitoDisabledReason: () => string | undefined;
  setVisibility: (visibility: NewSessionVisibility) => void;
};
