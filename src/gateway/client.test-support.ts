import { generateKeyPairSync } from "node:crypto";
import { vi } from "vitest";
import type { DeviceIdentity } from "../infra/device-identity.js";

export function createClientTestIdentity(deviceId: string): DeviceIdentity {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    deviceId,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
  };
}

export { waitForFast } from "../../test/helpers/vitest-wait.js";

export function firstMockArg(mock: ReturnType<typeof vi.fn>, label: string): unknown {
  const [arg] = mock.mock.calls[0] ?? [];
  if (arg === undefined) {
    throw new Error(`expected ${label}`);
  }
  return arg;
}

export function createAuthFailureMessage(): string {
  const failureUrl = new URL("wss://gateway.example/ws?token=secret-token");
  failureUrl.username = "user";
  failureUrl.password = "pass";
  return `Authorization: Bearer sk-testsecret1234567890abcd ${failureUrl.href}`; // pragma: allowlist secret
}

export const deviceAuthScopeCases = [
  {
    label: "bounded stored scopes",
    storedScopes: ["operator.write.no-credential-enrollment"],
    requestedScopes: undefined,
    deviceToken: undefined,
    expectedScopes: ["operator.write.no-credential-enrollment"],
  },
  {
    label: "stored scopes",
    storedScopes: ["operator.read", "operator.write"],
    requestedScopes: undefined,
    deviceToken: undefined,
    expectedScopes: ["operator.read", "operator.write"],
  },
  {
    label: "requested scopes",
    storedScopes: ["operator.write"],
    requestedScopes: ["operator.admin"],
    deviceToken: undefined,
    expectedScopes: ["operator.admin"],
  },
  {
    label: "explicit device token",
    storedScopes: ["operator.admin", "operator.read"],
    requestedScopes: ["operator.pairing"],
    deviceToken: "explicit-device-token",
    expectedScopes: ["operator.pairing"],
  },
];
