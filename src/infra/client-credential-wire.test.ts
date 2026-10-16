import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  runClientCredentialOperation,
  type ClientCredentialOperation,
  type ClientCredentialResult,
} from "./client-credential-store.js";
import { normalizeLegacyDeviceIdentity } from "./device-identity-legacy.js";

const directories = useAutoCleanupTempDirTracker(afterEach);

it("produces the shared Swift wire fixture from actual typed owner operations", async () => {
  const env = { OPENCLAW_STATE_DIR: directories.make("credential-wire-") };
  const cases: {
    name: string;
    operation: ClientCredentialOperation;
    result: ClientCredentialResult;
  }[] = [];
  const record = (name: string, operation: ClientCredentialOperation) => {
    const result = runClientCredentialOperation(env, operation);
    cases.push({ name, operation, result });
    return result;
  };
  const material = normalizeLegacyDeviceIdentity({
    deviceId: "56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c",
    publicKey: "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=",
    privateKey: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=", // pragma: allowlist secret
    createdAtMs: 123,
  });
  if (!material) {
    throw new Error("Invalid fixed Ed25519 fixture");
  }
  const identity = {
    identity_key: "primary",
    device_id: material.deviceId,
    public_key_pem: material.publicKeyPem,
    private_key_pem: material.privateKeyPem,
    created_at_ms: 123,
    updated_at_ms: 456,
  };
  expect(record("fixed identity", { kind: "identity.create", identity })).toEqual({
    kind: "identity",
    identity,
  });
  const fallback = {
    socket_key: "current" as const,
    socket_path: "/synthetic/exec.sock",
    socket_token: "socket/é雪",
    updated_at_ms: 10,
  };
  expect(record("socket first ensure", { kind: "socket.ensure", fallback })).toEqual({
    kind: "socket",
    socket: fallback,
  });
  expect(
    record("socket preserves bytes and timestamp", {
      kind: "socket.ensure",
      fallback: {
        ...fallback,
        socket_path: "/other.sock",
        socket_token: "discarded",
        updated_at_ms: 20,
      },
    }),
  ).toEqual({ kind: "socket", socket: fallback });
  expect(
    record("socket requested replacement", {
      kind: "socket.ensure",
      fallback: { ...fallback, updated_at_ms: 30 },
      requested: { path: " /synthetic/replaced.sock ", token: " replacement/é " },
    }),
  ).toEqual({
    kind: "socket",
    socket: {
      ...fallback,
      socket_path: "/synthetic/replaced.sock",
      socket_token: "replacement/é",
      updated_at_ms: 30,
    },
  });
  const token = {
    device_id: "wire-device",
    role: "operator",
    token: "initial/token/é雪",
    scopes_json: '[ "operator/read", "opérateur.é" ]',
    updated_at_ms: 40,
  };
  const key = { device_id: token.device_id, role: token.role };
  expect(
    record("token unconditional create omitted expected", { kind: "token.replace", key, token }),
  ).toEqual({ kind: "changed", changed: true });
  expect(
    record("token null means absent", {
      kind: "token.replace",
      key,
      token: { ...token, token: "must-not-win" },
      expectedToken: null,
    }),
  ).toEqual({ kind: "changed", changed: false });
  expect(
    record("token stale expected", {
      kind: "token.replace",
      key,
      token: { ...token, token: "must-not-win" },
      expectedToken: "stale",
    }),
  ).toEqual({ kind: "changed", changed: false });
  expect(
    record("token matching expected", {
      kind: "token.replace",
      key,
      token: { ...token, token: "refreshed/é" },
      expectedToken: token.token,
    }),
  ).toEqual({ kind: "changed", changed: true });
  expect(
    record("token stale observation cannot revoke", {
      kind: "token.remove",
      key,
      observedToken: token.token,
    }),
  ).toEqual({ kind: "changed", changed: false });
  expect(
    record("token trim-equivalent observation revokes", {
      kind: "token.remove",
      key,
      observedToken: " refreshed/é ",
    }),
  ).toEqual({ kind: "changed", changed: true });
  expect(record("revoked token absent", { kind: "token.read", key })).toEqual({
    kind: "token",
    token: null,
  });
  const native = { ...token, role: "opérateur", token: "native/token/雪", updated_at_ms: 50 };
  const nativeKey = { device_id: native.device_id, role: native.role };
  const scopedKey = { ...nativeKey, role: "v2.d3NzOi8v5L6LLmludmFsaWQvw6k.b3DDqXJhdGV1cg" };
  record("native unscoped token", { kind: "token.replace", key: nativeKey, token: native });
  expect(
    record("native Unicode claim", {
      kind: "native.token.claim",
      device_id: native.device_id,
      role: native.role,
      gateway: "wss://例.invalid/é",
    }),
  ).toEqual({ kind: "changed", changed: true });
  expect(
    record("native independently encoded key", { kind: "token.read", key: scopedKey }),
  ).toEqual({ kind: "token", token: { ...native, role: scopedKey.role } });
  record("native new unscoped token", {
    kind: "token.replace",
    key: nativeKey,
    token: { ...native, token: "must-not-replace-scoped" },
  });
  record("native scoped winner claim", {
    kind: "native.token.claim",
    device_id: native.device_id,
    role: native.role,
    gateway: "wss://例.invalid/é",
  });
  expect(record("native scoped winner survives", { kind: "token.read", key: scopedKey })).toEqual({
    kind: "token",
    token: { ...native, role: scopedKey.role },
  });
  expect(record("native unscoped consumed", { kind: "token.read", key: nativeKey })).toEqual({
    kind: "token",
    token: null,
  });

  await expect(`${JSON.stringify({ format: 1, cases }, null, 2)}\n`).toMatchFileSnapshot(
    fileURLToPath(
      new URL(
        "../../apps/shared/OpenClawKit/Tests/OpenClawNativeStateTests/Fixtures/ClientCredentials/operations.json",
        import.meta.url,
      ),
    ),
  );
});
