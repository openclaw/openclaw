import type { Result } from "@openclaw/normalization-core/result";

export type UserPreferenceError =
  | { code: "invalid-entry-count" }
  | { code: "invalid-key" | "invalid-value" | "value-too-large"; key: string }
  | {
      code: "profile-key-limit";
      limit: number;
      currentCount: number;
    };

export type PreparedUserPreferenceUpdate = {
  serialized: Array<{ prefKey: string; valueJson: string }>;
  deletionKeys: string[];
};

export type CanonicalUserPreferences = {
  profileId: string;
  entries: Record<string, unknown>;
};

export type UserPreferenceWorkerOperations = {
  "userPreferences.read": {
    input: { profileId: string; keys?: readonly string[] };
    output: CanonicalUserPreferences | undefined;
  };
  "userPreferences.write": {
    input: { profileId: string; update: PreparedUserPreferenceUpdate };
    output: Result<{ profileId: string }, UserPreferenceError> | undefined;
  };
};
