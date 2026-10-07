import {
  captureCommandOwnerAssertion,
  getCommandOwnerAuthority,
} from "../auto-reply/command-owner-authority.js";
/**
 * Trusted human fallback authority for delegated execution ownership.
 *
 * Authority is a Host capability, not a claim. It is minted only from a Host
 * ingress context that carries (a) an opaque ChannelAdmissionEvidence bound to
 * that exact context by the Host ingress runtime and (b) a live
 * CommandOwnerAuthority assertion. The capability is branded with a
 * module-private Symbol and re-checks both proofs on every use. Model output,
 * tool arguments, plugin-supplied objects, and caller-supplied identifier
 * strings cannot produce or replay it.
 */
import {
  compareChannelAdmissionParticipants,
  readChannelContextAdmissionEvidence,
  type ChannelAdmissionEvidence,
} from "../channels/message-access/admission-evidence.js";

export const TRUSTED_HUMAN_FALLBACK_INTENTS = ["fallback", "revoke"] as const;
export type TrustedHumanFallbackIntent = (typeof TRUSTED_HUMAN_FALLBACK_INTENTS)[number];

const TRUSTED_HUMAN_FALLBACK_AUTHORITY = Symbol("openclaw.trustedHumanFallbackAuthority");

type AuthorityInner = Readonly<{
  delegationRef: string;
  intent: TrustedHumanFallbackIntent;
  authorityRef: string;
  assertCurrent: () => void;
}>;

class TrustedHumanFallbackCapability {
  readonly #inner: AuthorityInner;

  constructor(inner: AuthorityInner) {
    this.#inner = inner;
    Object.setPrototypeOf(this, null);
    Object.freeze(this);
  }

  static read(this: void, value: unknown): TrustedHumanFallbackCapability | undefined {
    return typeof value === "object" && value !== null && #inner in value
      ? (value as TrustedHumanFallbackCapability)
      : undefined;
  }

  readonly delegationRef = (): string => this.#inner.delegationRef;
  readonly intent = (): TrustedHumanFallbackIntent => this.#inner.intent;
  readonly authorityRef = (): string => this.#inner.authorityRef;
  readonly assertCurrent = (): void => this.#inner.assertCurrent();
}

const readCapability = TrustedHumanFallbackCapability.read;

export class TrustedHumanFallbackAuthorityError extends Error {
  readonly code: "missing-host-authority" | "ref-mismatch" | "intent-mismatch" | "stale-authority";
  constructor(code: TrustedHumanFallbackAuthorityError["code"], message: string) {
    super(message);
    this.name = "TrustedHumanFallbackAuthorityError";
    this.code = code;
  }
}

export type TrustedHumanFallbackAuthority = Readonly<{
  delegationRef: string;
  intent: TrustedHumanFallbackIntent;
  authorityRef: string;
  assertCurrent: () => void;
}>;

/** The exact ingress context that carries live owner authority and evidence. */
export type TrustedHumanIngressContext = object;

/**
 * Mints authority only from a Host ingress context that carries both a live
 * command-owner authority and the opaque channel admission evidence bound to
 * that same context. Caller-supplied identifier strings are never accepted in
 * place of that evidence.
 */
export function mintTrustedHumanFallbackAuthority(params: {
  ingressContext: TrustedHumanIngressContext;
  /** Opaque Host-derived evidence; structurally identical copies are refused. */
  admissionEvidence: ChannelAdmissionEvidence;
  delegationRef: string;
  intent: TrustedHumanFallbackIntent;
  authorityRef: string;
}): TrustedHumanFallbackAuthority {
  const boundEvidence = readChannelContextAdmissionEvidence(params.ingressContext);
  if (boundEvidence === undefined || boundEvidence !== params.admissionEvidence) {
    throw new TrustedHumanFallbackAuthorityError(
      "missing-host-authority",
      "trusted human fallback requires Host channel admission evidence bound to this ingress context",
    );
  }
  if (compareChannelAdmissionParticipants([boundEvidence]) !== "same") {
    throw new TrustedHumanFallbackAuthorityError(
      "missing-host-authority",
      "trusted human fallback requires valid Host ingress evidence",
    );
  }
  if (!getCommandOwnerAuthority(params.ingressContext)) {
    throw new TrustedHumanFallbackAuthorityError(
      "missing-host-authority",
      "trusted human fallback requires a live Host command-owner authority",
    );
  }
  const assertOwnerCurrent = captureCommandOwnerAssertion(params.ingressContext);
  if (!assertOwnerCurrent) {
    throw new TrustedHumanFallbackAuthorityError(
      "missing-host-authority",
      "trusted human fallback requires a live Host command-owner authority",
    );
  }
  const assertCurrent = (): void => {
    assertOwnerCurrent();
    if (compareChannelAdmissionParticipants([boundEvidence]) !== "same") {
      throw new Error("Host ingress evidence is no longer current; send a new request.");
    }
  };
  const capability = new TrustedHumanFallbackCapability({
    delegationRef: params.delegationRef,
    intent: params.intent,
    authorityRef: params.authorityRef,
    assertCurrent,
  });
  const branded: Record<symbol, unknown> = {};
  branded[TRUSTED_HUMAN_FALLBACK_AUTHORITY] = capability;
  return Object.freeze(branded) as unknown as TrustedHumanFallbackAuthority;
}

/** Reads authority from a Host-branded value. Wire data and plugin objects fail here. */
export function resolveTrustedHumanFallbackAuthority(
  value: unknown,
): TrustedHumanFallbackAuthority | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const capability = readCapability(Reflect.get(value, TRUSTED_HUMAN_FALLBACK_AUTHORITY));
  if (!capability) {
    return undefined;
  }
  return Object.freeze({
    delegationRef: capability.delegationRef(),
    intent: capability.intent(),
    authorityRef: capability.authorityRef(),
    assertCurrent: capability.assertCurrent,
  });
}

/**
 * Validates authority against the exact delegation_ref and intent, then proves
 * it is still current. Every failure is a refusal, never a downgrade.
 */
export function requireTrustedHumanFallbackAuthority(params: {
  authority: unknown;
  delegationRef: string;
  intent: TrustedHumanFallbackIntent;
}): TrustedHumanFallbackAuthority {
  const resolved = resolveTrustedHumanFallbackAuthority(params.authority);
  if (!resolved) {
    throw new TrustedHumanFallbackAuthorityError(
      "missing-host-authority",
      "trusted human fallback authority is not a Host capability",
    );
  }
  if (resolved.delegationRef !== params.delegationRef) {
    throw new TrustedHumanFallbackAuthorityError(
      "ref-mismatch",
      "trusted human authority does not bind this delegation_ref",
    );
  }
  if (resolved.intent !== params.intent) {
    throw new TrustedHumanFallbackAuthorityError(
      "intent-mismatch",
      "trusted human authority does not grant this intent",
    );
  }
  try {
    resolved.assertCurrent();
  } catch (error) {
    throw new TrustedHumanFallbackAuthorityError(
      "stale-authority",
      error instanceof Error ? error.message : "trusted human authority is no longer current",
    );
  }
  return resolved;
}
