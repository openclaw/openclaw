import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ReplyOperation, ReplyToolAuthoritySnapshot } from "./reply-run-registry.contracts.js";

type OperationToolAuthority = Pick<
  ReplyOperation,
  | "toolAuthorityFingerprint"
  | "toolAuthorityRoute"
  | "requestedToolAuthorityRoute"
  | "automaticFallbackRoute"
  | "bindToolAuthoritySnapshot"
  | "projectToolAuthorityFingerprint"
  | "bindToolAuthorityRoute"
  | "setAutomaticFallbackRoute"
> & { bindBackendFingerprint(fingerprint: string | undefined): void };

/** Owns frozen policy, concrete attempt routing, and backend authority for one operation. */
export function createReplyOperationToolAuthority(lifecycle: {
  isOpen: () => boolean;
  ownsRunSlot: () => boolean;
}): OperationToolAuthority {
  let fingerprint: string | undefined;
  let snapshot: ReplyToolAuthoritySnapshot | undefined;
  let route: ReplyOperation["toolAuthorityRoute"];
  let automaticFallbackRoute: ReplyOperation["automaticFallbackRoute"];

  return {
    get toolAuthorityFingerprint() {
      return fingerprint;
    },
    get toolAuthorityRoute() {
      return route;
    },
    get requestedToolAuthorityRoute() {
      return snapshot?.requestedRoute;
    },
    get automaticFallbackRoute() {
      return automaticFallbackRoute;
    },
    bindBackendFingerprint(value) {
      const backendFingerprint = normalizeOptionalString(value);
      if (lifecycle.isOpen() && backendFingerprint) {
        fingerprint = backendFingerprint;
      }
    },
    setAutomaticFallbackRoute(value) {
      if (lifecycle.isOpen() && lifecycle.ownsRunSlot()) {
        automaticFallbackRoute = value ? Object.freeze({ ...value }) : undefined;
      }
    },
    bindToolAuthoritySnapshot(value) {
      if (!lifecycle.isOpen() || (snapshot && snapshot !== value)) {
        throw new Error("Reply operation cannot change tool authority after admission");
      }
      if (snapshot) {
        return;
      }
      const initialFingerprint = normalizeOptionalString(value.fingerprint());
      if (!initialFingerprint) {
        throw new Error("Reply operation tool authority fingerprint is required");
      }
      snapshot = value;
      fingerprint = initialFingerprint;
    },
    projectToolAuthorityFingerprint(overlay) {
      if (!lifecycle.isOpen() || !snapshot || !route) {
        return undefined;
      }
      try {
        return normalizeOptionalString(snapshot.project(overlay, route));
      } catch {
        return undefined;
      }
    },
    bindToolAuthorityRoute(value) {
      if (!lifecycle.isOpen() || !snapshot || !lifecycle.ownsRunSlot()) {
        throw new Error("Reply operation has no active tool authority snapshot");
      }
      const provider = normalizeOptionalString(value.provider);
      const model = normalizeOptionalString(value.model);
      if (!provider || !model) {
        throw new Error("Reply operation tool authority route is required");
      }
      const preparedRoute = { provider, model };
      const preparedFingerprint = snapshot.fingerprint(preparedRoute);
      route = preparedRoute;
      fingerprint = preparedFingerprint;
      return fingerprint;
    },
  };
}
