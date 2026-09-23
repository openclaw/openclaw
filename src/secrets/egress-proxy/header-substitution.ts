// Upstream header credential substitution for the secret egress proxy.
//
// Header values can carry a registered sentinel either literally or base64-encoded
// inside an HTTP Basic credential. Both shapes are resolved through one callback so
// the caller keeps ownership of run liveness and exact-host binding.
import type { IncomingHttpHeaders } from "node:http";
import { SecretEgressSubstitutionError } from "./stream-substitution.js";

/** Resolves one sentinel for the current run and destination, or undefined when unregistered. */
export type SecretEgressSentinelResolver = (sentinel: string) => string | undefined;

type SecretEgressHeaderSubstitution = { value: string; substituted: boolean };

/** Basic credentials use the standard alphabet, so URL-safe base64 is not accepted. */
const BASIC_AUTHORIZATION_PATTERN = /^Basic\s+([A-Za-z0-9+/]+={0,2})$/iu;

/** Replaces every sentinel in one value, leaving unresolved sentinels in place. */
export function substituteLiteralSentinel(params: {
  value: string;
  urlMode: boolean;
  resolveSentinel: SecretEgressSentinelResolver;
  sentinelPattern: RegExp;
  containsSentinel: (value: string) => boolean;
}): SecretEgressHeaderSubstitution {
  if (!params.containsSentinel(params.value)) {
    return { value: params.value, substituted: false };
  }
  let substituted = false;
  const swapped = params.value.replace(
    new RegExp(params.sentinelPattern.source, "g"),
    (sentinel) => {
      const resolved = params.resolveSentinel(sentinel);
      if (resolved === undefined) {
        return sentinel;
      }
      substituted = true;
      return params.urlMode ? encodeURIComponent(resolved) : resolved;
    },
  );
  return { value: swapped, substituted };
}

/**
 * Substitutes a sentinel carried as an upstream HTTP Basic credential.
 *
 * Clients that only support Basic merge user and password and base64-encode the
 * result, so the literal sentinel never appears in the header and the plaintext
 * matcher cannot see it. Decoding here is not a new disclosure: the value is
 * only read to find a sentinel this run already registered, and the plaintext is
 * re-encoded before egress. Authorization is unchanged because the resolver
 * applies the same run liveness and exact-host binding as the plaintext path.
 * Anything this cannot read faithfully 鈥?a non-canonical or non-UTF-8 payload,
 * or no `user:password` separator 鈥?is forwarded byte-identical to how it arrived.
 */
function swapBasicAuthorizationText(params: {
  value: string;
  resolveSentinel: SecretEgressSentinelResolver;
  sentinelPattern: RegExp;
  containsSentinel: (value: string) => boolean;
}): SecretEgressHeaderSubstitution {
  const unchanged = { value: params.value, substituted: false };
  const encoded = BASIC_AUTHORIZATION_PATTERN.exec(params.value.trim())?.[1];
  if (!encoded) {
    return unchanged;
  }
  const decoded = Buffer.from(encoded, "base64");
  // `Buffer.from(..., "base64")` is lenient about trailing bits and padding, so
  // only accept a payload that re-encodes to what arrived. Malformed credentials
  // forward unchanged.
  if (decoded.toString("base64").replace(/=+$/u, "") !== encoded.replace(/=+$/u, "")) {
    return unchanged;
  }
  // Secrets are UTF-8 everywhere else in the store, so read the credential the
  // same way. A credential that is not valid UTF-8, such as a binary or Latin-1
  // password, would be rewritten by the round trip, so it forwards unchanged
  // rather than being silently corrupted.
  const credentials = decoded.toString("utf8");
  if (!Buffer.from(credentials, "utf8").equals(decoded)) {
    return unchanged;
  }
  if (!credentials.includes(":")) {
    return unchanged;
  }
  const swapped = substituteLiteralSentinel({
    value: credentials,
    urlMode: false,
    resolveSentinel: params.resolveSentinel,
    sentinelPattern: params.sentinelPattern,
    containsSentinel: params.containsSentinel,
  });
  // A sentinel this run cannot resolve must refuse, not travel upstream as a
  // credential. The plaintext path reaches the same verdict in its caller.
  if (params.containsSentinel(swapped.value)) {
    throw new SecretEgressSubstitutionError("unresolved-sentinel");
  }
  if (!swapped.substituted) {
    return unchanged;
  }
  return {
    value: `Basic ${Buffer.from(swapped.value, "utf8").toString("base64")}`,
    substituted: true,
  };
}

/** Substitutes one header value, covering both literal and Basic-encoded sentinels. */
function swapSecretEgressHeaderValue(params: {
  /** Lowercased header name. */
  name: string;
  value: string;
  substituteLiteral: (value: string) => SecretEgressHeaderSubstitution;
  resolveSentinel: SecretEgressSentinelResolver;
  sentinelPattern: RegExp;
  containsSentinel: (value: string) => boolean;
}): SecretEgressHeaderSubstitution {
  const swapped = params.substituteLiteral(params.value);
  if (swapped.substituted || params.name !== "authorization") {
    return swapped;
  }
  return swapBasicAuthorizationText(params);
}

/** Substitutes every non-proxy header value, including array-valued headers. */
export function swapSecretEgressHeaders(params: {
  headers: IncomingHttpHeaders;
  substituteLiteral: (value: string) => SecretEgressHeaderSubstitution;
  resolveSentinel: SecretEgressSentinelResolver;
  sentinelPattern: RegExp;
  containsSentinel: (value: string) => boolean;
}): { headers: IncomingHttpHeaders; substituted: boolean } {
  const output: IncomingHttpHeaders = {};
  let substituted = false;
  for (const [name, rawValue] of Object.entries(params.headers)) {
    const lowerName = name.toLowerCase();
    if (lowerName === "proxy-authorization" || lowerName === "proxy-connection") {
      continue;
    }
    const swap = (value: string) =>
      swapSecretEgressHeaderValue({
        name: lowerName,
        value,
        substituteLiteral: params.substituteLiteral,
        resolveSentinel: params.resolveSentinel,
        sentinelPattern: params.sentinelPattern,
        containsSentinel: params.containsSentinel,
      });
    if (Array.isArray(rawValue)) {
      output[name] = rawValue.map((value) => {
        const swapped = swap(value);
        substituted ||= swapped.substituted;
        return swapped.value;
      });
      continue;
    }
    if (rawValue !== undefined) {
      const swapped = swap(rawValue);
      substituted ||= swapped.substituted;
      output[name] = swapped.value;
    }
  }
  return { headers: output, substituted };
}
