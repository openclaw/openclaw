import { normalizeWritingOrigin } from "./dictation-writing-profile-schema.js";
import {
  BASELINE_WRITING_POLICY,
  type WritingProfile,
  type WritingProfileCapabilities,
  type WritingProfileCatalog,
  type WritingProfileContext,
  type WritingProfilePolicy,
  type WritingProfileReason,
  type WritingProfileRestrictions,
  type WritingProfileSnapshot,
  type WritingTransform,
} from "./dictation-writing-profile-types.js";

export {
  createDefaultWritingProfileCatalog,
  normalizeWritingOrigin,
  prepareWritingProfileImport,
  validateWritingProfileCatalog,
} from "./dictation-writing-profile-schema.js";
export * from "./dictation-writing-profile-types.js";

export type ResolveWritingProfileInput = Readonly<{
  catalog: WritingProfileCatalog;
  overrideId?: string | null;
  context: WritingProfileContext;
  capabilities: WritingProfileCapabilities;
  restrictions: WritingProfileRestrictions;
}>;

function requestedTransforms(policy: WritingProfilePolicy): WritingTransform[] {
  const requested: WritingTransform[] = [];
  if (policy.locale !== null) {
    requested.push("locale");
  }
  for (const key of [
    "punctuation",
    "capitalization",
    "fillers",
    "corrections",
    "structure",
  ] as const) {
    if (policy[key] !== "preserve") {
      requested.push(key);
    }
  }
  return requested;
}

/** Return no winner on equal-priority matches, independent of record order. */
function highestPriority(profiles: readonly WritingProfile[]): WritingProfile | "conflict" | null {
  let selected: WritingProfile | null = null;
  let tied = false;
  for (const profile of profiles) {
    if (!selected || profile.priority > selected.priority) {
      selected = profile;
      tied = false;
    } else if (profile.priority === selected.priority) {
      tied = true;
    }
  }
  return tied ? "conflict" : selected;
}

function selectProfile(input: ResolveWritingProfileInput): {
  profile: WritingProfile | null;
  reason: WritingProfileReason;
} {
  const { catalog, context, overrideId } = input;
  if (!catalog.enabled) {
    return { profile: null, reason: "disabled" };
  }
  const enabled = catalog.profiles.filter((profile) => profile.enabled);
  const global = enabled.find((profile) => profile.id === catalog.defaultProfileId) ?? null;
  if (overrideId !== null && overrideId !== undefined) {
    const override = enabled.find((profile) => profile.id === overrideId);
    return override
      ? { profile: override, reason: "session-override" }
      : { profile: global, reason: "override-unavailable" };
  }
  const app = context.application;
  if (
    !app.supported ||
    !app.consent ||
    !app.trusted ||
    !app.identity ||
    context.field !== "editable"
  ) {
    return { profile: global, reason: "identity-unavailable" };
  }
  const appIdentity = app.identity;
  const originState = context.origin;
  const origin =
    originState.supported && originState.consent && originState.trusted && originState.value
      ? normalizeWritingOrigin(originState.value)
      : null;
  for (const kind of ["origin", "application"] as const) {
    const matching = enabled.filter((profile) =>
      profile.selectors.some(
        (selector) =>
          selector.kind === kind &&
          selector.app.kind === appIdentity.kind &&
          selector.app.id === appIdentity.id &&
          (selector.kind === "application" || (origin !== null && selector.origin === origin)),
      ),
    );
    const selected = highestPriority(matching);
    if (selected === "conflict") {
      return { profile: global, reason: "selector-conflict" };
    }
    if (selected) {
      return {
        profile: selected,
        reason: kind === "origin" ? "application-origin" : "application",
      };
    }
  }
  return { profile: global, reason: global ? "global-default" : "no-default" };
}

/** Pure policy selection. Callers admit settings/context; this never collects identity or requests a provider. */
export function resolveWritingProfile(input: ResolveWritingProfileInput): WritingProfileSnapshot {
  const { catalog, context, capabilities, restrictions } = input;
  const { profile, reason } = selectProfile(input);
  const requested = requestedTransforms(profile?.policy ?? BASELINE_WRITING_POLICY);
  const unavailable = requested.filter(
    (key) =>
      !capabilities.transforms.includes(key) ||
      (key === "locale" && !(capabilities.locales ?? []).includes(profile?.policy.locale ?? "")),
  );
  const captureAllowed = restrictions.captureAllowed && context.field !== "secure";
  const restrictiveReasons: string[] = [];
  if (!captureAllowed) {
    restrictiveReasons.push("capture-blocked");
  }
  if (!restrictions.refinementAllowed) {
    restrictiveReasons.push("refinement-blocked");
  }
  if (!restrictions.providerAllowed) {
    restrictiveReasons.push("provider-blocked");
  }
  if (
    restrictions.forceLiteral ||
    (profile?.policy.handling === "literal" && requested.length > 0)
  ) {
    restrictiveReasons.push("literal-required");
  }
  const disallowed = requested.filter((key) => !restrictions.allowedTransforms.includes(key));
  restrictiveReasons.push(...disallowed.map((key) => `${key}-blocked`));
  const blocked =
    !captureAllowed ||
    !restrictions.refinementAllowed ||
    !restrictions.providerAllowed ||
    restrictions.forceLiteral;
  const canApply =
    profile && !blocked && unavailable.length === 0 && reason !== "selector-conflict";
  const effectivePolicy: WritingProfilePolicy =
    canApply && profile.policy.handling !== "literal"
      ? Object.freeze({
          handling: profile.policy.handling,
          locale: disallowed.includes("locale") ? null : profile.policy.locale,
          punctuation: disallowed.includes("punctuation") ? "preserve" : profile.policy.punctuation,
          capitalization: disallowed.includes("capitalization")
            ? "preserve"
            : profile.policy.capitalization,
          fillers: disallowed.includes("fillers") ? "preserve" : profile.policy.fillers,
          corrections: disallowed.includes("corrections") ? "preserve" : profile.policy.corrections,
          structure: disallowed.includes("structure") ? "preserve" : profile.policy.structure,
          // Register remains an advisory UI value until separately accepted semantic evaluation.
          register: "unchanged",
        })
      : BASELINE_WRITING_POLICY;
  const status =
    reason === "disabled"
      ? "disabled"
      : reason === "selector-conflict"
        ? "conflict"
        : restrictiveReasons.length
          ? "restricted"
          : unavailable.length
            ? "unavailable"
            : profile
              ? "active"
              : "baseline";
  return Object.freeze({
    schemaVersion: 1,
    catalogRevision: catalog.revision,
    profileId: profile?.id ?? null,
    profileRevision: profile?.revision ?? null,
    profileLabel: profile?.label ?? null,
    reason,
    status,
    contextRevision: context.revision,
    consentRevision: context.consentRevision,
    contextPolicyRevision: context.policyRevision,
    contextCapabilities: Object.freeze({
      application: context.application.supported,
      origin: context.origin.supported,
    }),
    contextPermissions: Object.freeze({
      application: context.application.consent,
      origin: context.origin.consent,
    }),
    policyRevision: restrictions.revision,
    capabilityRevision: capabilities.revision,
    capabilities: Object.freeze([...capabilities.transforms]),
    capabilityLocales: Object.freeze([...(capabilities.locales ?? [])]),
    effectivePolicy,
    advisoryRegister: profile?.policy.register ?? "unchanged",
    unavailable: Object.freeze(unavailable),
    restrictiveReasons: Object.freeze(restrictiveReasons),
    captureAllowed,
  });
}

/** Content-free diagnostics omit even imported profile IDs and revision strings. */
export function writingProfileDiagnostics(snapshot: WritingProfileSnapshot) {
  return Object.freeze({
    reason: snapshot.reason,
    status: snapshot.status,
    unavailable: snapshot.unavailable,
    captureAllowed: snapshot.captureAllowed,
  });
}
