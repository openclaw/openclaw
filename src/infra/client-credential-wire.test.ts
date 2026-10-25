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
  // The shared Swift fixture below asserts every recorded operation and exact result.
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
  record("fixed identity", { kind: "identity.create", identity });
  const fallback = {
    socket_key: "current" as const,
    socket_path: "/synthetic/exec.sock",
    socket_token: "socket/é雪",
    updated_at_ms: 10,
  };
  record("socket first ensure", { kind: "socket.ensure", fallback });
  record("socket preserves bytes and timestamp", {
    kind: "socket.ensure",
    fallback: {
      ...fallback,
      socket_path: "/other.sock",
      socket_token: "discarded",
      updated_at_ms: 20,
    },
  });
  record("socket requested replacement", {
    kind: "socket.ensure",
    fallback: { ...fallback, updated_at_ms: 30 },
    requested: { path: " /synthetic/replaced.sock ", token: " replacement/é " },
  });
  const token = {
    device_id: "wire-device",
    role: "operator",
    token: "initial/token/é雪",
    scopes_json: '[ "operator/read", "opérateur.é" ]',
    updated_at_ms: 40,
  };
  const key = { device_id: token.device_id, role: token.role };
  record("token unconditional create omitted expected", { kind: "token.replace", key, token });
  record("token null means absent", {
    kind: "token.replace",
    key,
    token: { ...token, token: "must-not-win" },
    expectedToken: null,
  });
  record("token stale expected", {
    kind: "token.replace",
    key,
    token: { ...token, token: "must-not-win" },
    expectedToken: "stale",
  });
  record("token matching expected", {
    kind: "token.replace",
    key,
    token: { ...token, token: "refreshed/é" },
    expectedToken: token.token,
  });
  record("token stale observation cannot revoke", {
    kind: "token.remove",
    key,
    observedToken: token.token,
  });
  const removals: [name: string, persisted: string, expected?: string | null, observed?: string][] =
    [
      [
        "normalized expected accepts exact raw observation",
        " cached-token ",
        "cached-token",
        " cached-token ",
      ],
      [
        "normalized expected rejects a different raw token with the same trim",
        "\tcached-token\n",
        "cached-token",
        " cached-token ",
      ],
      [
        "raw observation must normalize to expected",
        "unrelated-token",
        "cached-token",
        "unrelated-token",
      ],
      [
        "exact expected does not require a matching observation",
        "cached-token",
        "cached-token",
        "unrelated-token",
      ],
      [
        "observed-only removal rejects trim-equivalent bytes",
        "cached-token",
        undefined,
        " cached-token ",
      ],
      ["observed-only removal accepts exact bytes", " cached-token ", undefined, " cached-token "],
      [
        "explicit null does not allow a raw observation fallback",
        " cached-token ",
        null,
        " cached-token ",
      ],
      ["omitted expected and observation remove unconditionally", " cached-token "],
      [
        "normalization preserves composed and decomposed UTF8 bytes",
        " e\u0301 ",
        "\u00e9",
        " e\u0301 ",
      ],
      [
        "raw observation uses ECMAScript BOM trimming",
        "\ufeffcached-token\ufeff",
        "cached-token",
        "\ufeffcached-token\ufeff",
      ],
      [
        "raw observation does not trim Unicode next-line",
        "\u0085cached-token\u0085",
        "cached-token",
        "\u0085cached-token\u0085",
      ],
    ];
  for (const [name, persistedToken, expectedToken, observedToken] of removals) {
    record(`${name}: seed`, {
      kind: "token.replace",
      key,
      token: { ...token, token: persistedToken },
    });
    record(name, { kind: "token.remove", key, expectedToken, observedToken });
    record(`${name}: durable result`, { kind: "token.read", key });
  }
  const native = { ...token, role: "opérateur", token: "native/token/雪", updated_at_ms: 50 };
  const nativeKey = { device_id: native.device_id, role: native.role };
  const scopedKey = { ...nativeKey, role: "v2.d3NzOi8v5L6LLmludmFsaWQvw6k.b3DDqXJhdGV1cg" };
  record("native unscoped token", { kind: "token.replace", key: nativeKey, token: native });
  record("native Unicode claim", {
    kind: "native.token.claim",
    device_id: native.device_id,
    role: native.role,
    gateway: "wss://例.invalid/é",
  });
  record("native independently encoded key", { kind: "token.read", key: scopedKey });
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
  record("native scoped winner survives", { kind: "token.read", key: scopedKey });
  record("native unscoped consumed", { kind: "token.read", key: nativeKey });

  // Swift reconstructs the same fixed seed; the shared trace never stores a private PEM.
  const fixture = `${JSON.stringify({ format: 1, cases }, null, 2)}\n`.replaceAll(
    JSON.stringify(material.privateKeyPem),
    JSON.stringify("synthetic:ed25519-seed-0-through-31"),
  );
  await expect(fixture).toMatchFileSnapshot(
    fileURLToPath(
      new URL(
        "../../apps/shared/OpenClawKit/Tests/OpenClawNativeStateTests/Fixtures/ClientCredentials/operations.json",
        import.meta.url,
      ),
    ),
  );
});
