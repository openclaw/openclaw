/** Private M05 proposal; not a Gateway RPC or plugin SDK contract. */
export const WRITING_PROFILES_PREFERENCE_KEY = "dictation.writingProfiles";

export const WRITING_PROFILE_LIMITS = {
  catalogBytes: 1024 * 1024,
  profiles: 100,
  selectors: 20,
  label: 80,
  identifier: 256,
  revision: 128,
  origin: 2048,
  priority: 1000,
} as const;

export type WritingApplicationIdentity = Readonly<{
  kind: "macos-bundle-id" | "windows-aumid" | "linux-desktop-id";
  id: string;
}>;

export type WritingProfileSelector =
  | Readonly<{ kind: "application"; app: WritingApplicationIdentity }>
  | Readonly<{ kind: "origin"; app: WritingApplicationIdentity; origin: string }>;

export type WritingProfilePolicy = Readonly<{
  handling: "literal" | "prose";
  locale: string | null;
  punctuation: "preserve" | "automatic";
  capitalization: "preserve" | "sentence";
  fillers: "preserve" | "conservative";
  corrections: "preserve" | "explicit";
  structure: "preserve" | "paragraphs" | "lists";
  register: "unchanged" | "chat" | "email";
}>;

export type WritingProfile = Readonly<{
  id: string;
  revision: string;
  label: string;
  enabled: boolean;
  priority: number;
  selectors: readonly WritingProfileSelector[];
  policy: WritingProfilePolicy;
}>;

export type WritingProfileCatalog = Readonly<{
  schemaVersion: 1;
  revision: string;
  enabled: boolean;
  defaultProfileId: string | null;
  profiles: readonly WritingProfile[];
}>;

export type WritingProfileIssue = Readonly<{ path: string; code: string }>;
export type WritingProfileValidation =
  | Readonly<{ ok: true; catalog: WritingProfileCatalog }>
  | Readonly<{
      ok: false;
      issues: readonly WritingProfileIssue[];
      futureVersion?: number;
    }>;

/** Supplied only by the context owner. A display name is never an identity. */
export type WritingProfileContext = Readonly<{
  revision: string;
  consentRevision: string;
  policyRevision: string;
  field: "editable" | "secure" | "unknown";
  application: Readonly<{
    supported: boolean;
    consent: boolean;
    trusted: boolean;
    identity: WritingApplicationIdentity | null;
  }>;
  origin: Readonly<{
    supported: boolean;
    consent: boolean;
    trusted: boolean;
    value: string | null;
  }>;
}>;

export type WritingTransform =
  | "locale"
  | "punctuation"
  | "capitalization"
  | "fillers"
  | "corrections"
  | "structure";
export type WritingProfileCapabilities = Readonly<{
  revision: string;
  transforms: readonly WritingTransform[];
  locales?: readonly string[];
}>;

/** These values constrain a profile; a profile cannot widen any of them. */
export type WritingProfileRestrictions = Readonly<{
  revision: string;
  captureAllowed: boolean;
  refinementAllowed: boolean;
  providerAllowed: boolean;
  allowedTransforms: readonly WritingTransform[];
  forceLiteral: boolean;
}>;

export type WritingProfileReason =
  | "disabled"
  | "session-override"
  | "application-origin"
  | "application"
  | "global-default"
  | "identity-unavailable"
  | "override-unavailable"
  | "selector-conflict"
  | "no-default";

export type WritingProfileSnapshot = Readonly<{
  schemaVersion: 1;
  catalogRevision: string;
  profileId: string | null;
  profileRevision: string | null;
  profileLabel: string | null;
  reason: WritingProfileReason;
  status: "disabled" | "active" | "unavailable" | "restricted" | "conflict" | "baseline";
  contextRevision: string;
  consentRevision: string;
  contextPolicyRevision: string;
  contextCapabilities: Readonly<{ application: boolean; origin: boolean }>;
  contextPermissions: Readonly<{ application: boolean; origin: boolean }>;
  policyRevision: string;
  capabilityRevision: string;
  capabilities: readonly WritingTransform[];
  capabilityLocales: readonly string[];
  effectivePolicy: WritingProfilePolicy;
  advisoryRegister: WritingProfilePolicy["register"];
  unavailable: readonly WritingTransform[];
  restrictiveReasons: readonly string[];
  captureAllowed: boolean;
}>;

export const BASELINE_WRITING_POLICY: WritingProfilePolicy = Object.freeze({
  handling: "literal",
  locale: null,
  punctuation: "preserve",
  capitalization: "preserve",
  fillers: "preserve",
  corrections: "preserve",
  structure: "preserve",
  register: "unchanged",
});
