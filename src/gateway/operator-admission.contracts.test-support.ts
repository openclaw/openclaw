import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import type { OperatorRunRecoverySnapshot } from "./operator-run-recovery-source.codec.js";
import type { OperatorScope } from "./operator-scopes.js";
import type { GatewayClient } from "./server-methods/types.js";

export const ORIGIN = "https://admission.example.test";
export const WRITER: OperatorScope[] = ["operator.read", "operator.write"];
export const ADMIN: OperatorScope[] = ["operator.admin"];
export const PROXY_USER = "operator@example.test";
export const ADMIN_USER = "administrator@example.test";
export const proxyHeaders = (user: string) => ({
  "x-forwarded-user": user,
  "x-forwarded-for": "203.0.113.50",
  "x-forwarded-proto": "https",
});

export type LiveCredentialKind =
  | "live-device"
  | "live-proxy"
  | "live-grant"
  | "live-role"
  | "live-token"
  | "live-fallback"
  | "live-device-revoked"
  | "live-device-key-changed";

export type LiveAdmissionKind =
  // Shared HTTP bearer authenticates a system actor, not an admitted operator.
  | "http-bearer"
  | "http-ocid"
  | "openai-compatible"
  | "plugin-in-process"
  | "recorded-person"
  | "recorded-system-turn"
  | LiveCredentialKind
  | "live-remote-ingress"
  | "live-ingress"
  // These are separate run/receipt capabilities, not operator admission.
  | "cron-standing-grant"
  | "cron-management-grant"
  | "cron-operator-source";

export type LiveAdmissionProducer = {
  client?: GatewayClient;
  send?: (params: Record<string, unknown>) => Promise<{ runId: string }>;
  authority?: AdmittedRunOperatorAuthority;
  hasCurrentClientAuthority?: () => boolean;
  predecessor?: { runId: string; completion: Promise<unknown> };
  revoke: () => Promise<void>;
  release: () => void | Promise<void>;
};

type AuthMethod = Exclude<
  OperatorRunRecoverySnapshot,
  { sourceIngress: "principal" }
>["authPolicy"]["authMethod"];
type Credential =
  | AuthMethod
  | "fallback"
  | "proxy-device"
  | "tailscale-device"
  | "ocid-owner"
  | "ocid-member"
  | "principal"
  | "plugin-grant"
  | "channel";
type SavedRow = {
  credential: Credential;
  ingress: OperatorRunRecoverySnapshot["sourceIngress"] | "channel";
};
export type Row = SavedRow | { credential: LiveAdmissionKind; ingress: "live" };
export type Mode = "token" | "password" | "trusted-proxy";
export type Scenario =
  | "before-start"
  | "after-start"
  | "stop"
  | "method-disabled"
  | "legacy-method-disabled"
  | "legacy-fallback"
  | "legacy-rotated"
  | "fallback-proxy-policy"
  | "legacy-tailscale"
  | "legacy-tailscale-narrowed"
  | "narrowed-grant"
  | "narrowed-token"
  | "narrowed-ingress"
  | "device-token-revoked"
  | "device-role-unapproved"
  | "generation-unavailable"
  | "owner-disabled"
  | "widened-grant"
  | "narrowed-role"
  | "empty-after-role"
  | "pairing-unavailable"
  | "live-ocid-grant"
  | "goal-agent-excluded"
  | "mixed-owner-group"
  | "secondary-email-removed"
  | "profile-deleted"
  | "owner-revoked-before-start"
  | "plugin-resume-mismatch"
  | "plugin-authorize-denied"
  | "plugin-authorize-allowed"
  | "plugin-owner-unavailable"
  | "owner-unavailable";
