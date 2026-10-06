/**
 * Trusted human fallback authority for delegated execution ownership.
 *
 * Authority is a Host capability, not a claim. It is minted only from an
 * ingress context that carries a live CommandOwnerAuthority assertion
 * (`captureCommandOwnerAssertion`), is branded with a module-private Symbol,
 * and re-checks liveness on every use. Model output, tool arguments, and
 * plugin-supplied objects cannot produce or replay it.
 */
import { captureCommandOwnerAssertion } from "../auto-reply/command-owner-authority.js";
import { getCommandOwnerAuthority } from "../auto-reply/command-owner-authority.js";

export const TRUSTED_HUMAN_FALLBACK_INTENTS = ["fallback", "revoke"] as const;
export type TrustedHumanFallbackIntent = (typeof TRUSTED_HUMAN_FALLBACK_INTENTS)[number];

const TRUSTED_HUMAN_FALLBACK_AUTHORITY = Symbol("openclaw.trustedHumanFallbackAuthority");

type AuthorityInner = Readonly<{
  delegationRef: string;
  intent: TrustedHumanFallbackIntent;
  authorityRef: string;
  ownerRef: string;
  ingressRef: string;
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
  readonly ownerRef = (): string => this.#inner.ownerRef;
  readonly ingressRef = (): string => this.#inner.ingressRef;
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

export type TrustedHumanIngress = Readonly<{
  ingressRef: string;
  ownerRef: string;
}>;

/**
 * Mints authority only while the Host ingress still holds a live command-owner
 * assertion. A caller without that capability cannot mint anything.
 */
export function mintTrustedHumanFallbackAuthority(params: {
  ingressContext: object;
  ingress: TrustedHumanIngress;
  delegationRef: string;
  intent: TrustedHumanFallbackIntent;
  authorityRef: string;
}): TrustedHumanFallbackAuthority {
  if (!getCommandOwnerAuthority(params.ingressContext)) {
    throw new TrustedHumanFallbackAuthorityError(
      "missing-host-authority",
      "trusted human fallback requires a live Host command-owner authority",
    );
  }
  const assertCurrent = captureCommandOwnerAssertion(params.ingressContext);
  if (!assertCurrent) {
    throw new TrustedHumanFallbackAuthorityError(
      "missing-host-authority",
      "trusted human fallback requires a live Host command-owner authority",
    );
  }
  const capability = new TrustedHumanFallbackCapability({
    delegationRef: params.delegationRef,
    intent: params.intent,
    authorityRef: params.authorityRef,
    ownerRef: params.ingress.ownerRef,
    ingressRef: params.ingress.ingressRef,
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
