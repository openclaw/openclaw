import type { SecretEgressCertificateStatus } from "./certificates.js";
import type { SecretEgressProxyAuditEvent, SecretEgressSentinelBinding } from "./proxy-server.js";

export type SecretEgressWorkerData = {
  caDir: string;
  allowedHosts?: readonly string[];
  bypassHosts?: readonly string[];
  decryptionKey: Uint8Array;
  authority: Int32Array;
};

export type SecretEgressWorkerCommand =
  | {
      kind: "register";
      id: number;
      bindings: readonly SecretEgressSentinelBinding[];
      authority: Int32Array;
    }
  | { kind: "revoke" | "status" | "stop"; id: number };

export type SecretEgressWorkerReady = {
  kind: "ready";
  caCertPath: string;
  proxyOrigin: string;
};

export type SecretEgressWorkerReply =
  | { kind: "registered"; id: number; env: Record<string, string> }
  | { kind: "status"; id: number; status: SecretEgressCertificateStatus }
  | { kind: "stopped" | "failed"; id: number };

export type SecretEgressWorkerMessage =
  | SecretEgressWorkerReady
  | SecretEgressWorkerReply
  | { kind: "audit"; event: SecretEgressProxyAuditEvent }
  | { kind: "fatal" };
