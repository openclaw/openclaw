import { generateKeyPairSync, randomUUID } from "node:crypto";
import { assert, expect } from "vitest";
import { publicKeyRawBase64UrlFromPem } from "../infra/device-identity.js";
import { loadPairedDevicePairingStoreRecordReadOnly } from "../infra/device-pairing-store-readonly.js";
import { ensureDeviceToken, revokeDeviceToken } from "../infra/device-pairing-tokens.js";
import { removePairedDevice, withPairedDeviceRecords } from "../infra/device-pairing.js";
import { setCanonicalUserProfileRole } from "../state/user-profile-writes.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { resolveGatewayAuthForConfig } from "./auth-resolve.js";
import {
  ADMIN,
  ORIGIN,
  PROXY_USER,
  WRITER,
  type LiveAdmissionProducer,
  type LiveCredentialKind,
} from "./operator-admission.contracts.test-support.js";
import { prepareAdmissionOperator } from "./operator-admission.credentials.test-support.js";
import type { AdmissionFixture } from "./operator-admission.table.test-support.js";

export function isLiveCredentialKind(kind: string): kind is LiveCredentialKind {
  switch (kind) {
    case "live-device":
    case "live-proxy":
    case "live-grant":
    case "live-role":
    case "live-token":
    case "live-fallback":
    case "live-device-revoked":
    case "live-device-key-changed":
      return true;
    default:
      return false;
  }
}

// The real Origin gate URL-parses the serialized origin and matches allowedOrigins
// exactly; neither that gate nor the config string array imposes a length bound.
// ASCII DNS labels keep the 4.2KiB header well below Node's 16KiB upgrade limit,
// while authPolicy.browserOrigin.origin exceeds the durable codec's 4096 bound.
// Owner credentials bypass role modelPolicy, so its 257-deny boundary cannot
// exercise token/password live admission honestly.
const LIVE_ONLY_ORIGIN = `https://${Array.from({ length: 66 }, () => "a".repeat(63)).join(".")}.example.test`;

/** Real handshake facts whose accepted input cannot serialize a recovery source. */
export async function prepareLiveCredentialProducer(
  kind: LiveCredentialKind,
  fixture: AdmissionFixture,
): Promise<LiveAdmissionProducer> {
  const c = fixture.current;
  assert(c && fixture.kernel);
  const proxyCredential = kind !== "live-token" && kind !== "live-fallback";
  const proxyUser = c.scenario === "profile-deleted" ? `deleted-${c.id}@example.test` : PROXY_USER;
  const next = structuredClone(fixture.config);
  assert(next.gateway?.roles?.definitions.operator && next.gateway.auth);
  if (proxyCredential) {
    assert(
      next.gateway.auth.mode === "trusted-proxy",
      "Live proxy credentials belong in the identified proxy pool",
    );
    if (proxyUser !== PROXY_USER) {
      assert(next.gateway.auth.trustedProxy?.allowUsers && next.gateway.auth.identityScopes);
      next.gateway.auth.trustedProxy.allowUsers.push(proxyUser);
      next.gateway.auth.identityScopes[proxyUser] = [...WRITER];
    }
    // Valid live policy beyond the codec's 256-wildcard bound. None of the
    // denied providers is the fixture's actual provider.
    next.gateway.roles.definitions.operator.modelPolicy = {
      deny: Array.from({ length: 257 }, (_, index) => `unrelated-${index}/*`),
    };
    if (kind === "live-grant" || kind === "live-role") {
      assert(next.gateway.auth.identityScopes);
      next.gateway.auth.identityScopes[proxyUser] = [...WRITER, "operator.approvals"];
    }
    if (kind === "live-role") {
      next.gateway.roles.definitions["live-role-narrowed"] = {
        ...next.gateway.roles.definitions.operator,
        scopes: [...WRITER],
      };
    }
  } else {
    assert(
      next.gateway.auth.mode === (kind === "live-token" ? "token" : "trusted-proxy"),
      "Live token uses the token pool; fallback uses the proxy pool's environment password",
    );
    next.gateway.controlUi = {
      ...next.gateway.controlUi,
      allowedOrigins: [...(next.gateway.controlUi?.allowedOrigins ?? []), LIVE_ONLY_ORIGIN],
    };
  }
  await fixture.publish(next, c.signal);

  const deviceLess = kind === "live-grant" || kind === "live-role";
  const browser = !proxyCredential || deviceLess;
  const operator = await prepareAdmissionOperator(fixture, c, {
    credential: proxyCredential
      ? deviceLess
        ? "trusted-proxy"
        : "proxy-device"
      : kind === "live-token"
        ? "token"
        : "fallback",
    scopes: deviceLess ? [...WRITER, "operator.approvals"] : WRITER,
    ingress: browser ? "control-ui" : "internal",
    origin: proxyCredential ? ORIGIN : LIVE_ONLY_ORIGIN,
    proxyUser,
  });
  if (kind === "live-device-revoked" || kind === "live-device-key-changed") {
    // This incidental token is not used for proxy authentication. Its real
    // owner makes the revokedAt guard independently exercisable.
    assert(
      await ensureDeviceToken({
        deviceId: c.identity.deviceId,
        role: "operator",
        scopes: WRITER,
      }),
    );
  }
  const self = await operator.request<{ profile: { id: string } }>("users.self", {});
  if (proxyCredential) {
    await setCanonicalUserProfileRole(self.profile.id, "operator");
  }
  await fixture.setSessionOwner(self.profile.id);
  const fallbackEnv =
    kind === "live-fallback" ? captureEnv(["OPENCLAW_GATEWAY_PASSWORD"]) : undefined;
  return {
    send: (params) => operator.request("chat.send", params),
    revoke: async () => {
      switch (kind) {
        case "live-role":
          await setCanonicalUserProfileRole(self.profile.id, "live-role-narrowed");
          return;
        case "live-grant": {
          const narrowed = structuredClone(fixture.config);
          assert(narrowed.gateway?.auth?.identityScopes);
          narrowed.gateway.auth.identityScopes[proxyUser] = [...WRITER];
          await fixture.publish(narrowed, c.signal);
          return;
        }
        case "live-proxy": {
          const revoked = structuredClone(fixture.config);
          assert(revoked.gateway?.auth?.trustedProxy?.allowUsers);
          revoked.gateway.auth.trustedProxy.allowUsers =
            revoked.gateway.auth.trustedProxy.allowUsers.filter((user) => user !== proxyUser);
          await fixture.publish(revoked, c.signal);
          return;
        }
        case "live-device":
          expect(await removePairedDevice(c.identity.deviceId)).not.toBeNull();
          return;
        case "live-device-revoked": {
          const before = await loadPairedDevicePairingStoreRecordReadOnly(c.identity.deviceId);
          assert(before?.tokens?.operator);
          expect(before.tokens.operator.revokedAtMs).toBeUndefined();
          const revoked = await revokeDeviceToken({
            deviceId: c.identity.deviceId,
            role: "operator",
            callerScopes: ADMIN,
          });
          assert(revoked.ok);
          expect(revoked.entry.revokedAtMs).toEqual(expect.any(Number));
          expect(await loadPairedDevicePairingStoreRecordReadOnly(c.identity.deviceId)).toEqual({
            ...before,
            tokens: { ...before.tokens, operator: revoked.entry },
          });
          return;
        }
        case "live-device-key-changed": {
          const { publicKey } = generateKeyPairSync("ed25519");
          const replacementKey = publicKeyRawBase64UrlFromPem(
            publicKey.export({ type: "spki", format: "pem" }),
          );
          const before = await withPairedDeviceRecords(undefined, (devices) => {
            const device = devices[c.identity.deviceId];
            assert(device?.tokens?.operator);
            expect(device.tokens.operator.revokedAtMs).toBeUndefined();
            expect(device.publicKey).not.toBe(replacementKey);
            const original = structuredClone(device);
            device.publicKey = replacementKey;
            return { value: original, persist: true };
          });
          // Keep the actual row/id, role approval and token intact: only the
          // independently generated key differs from the source's handshake.
          expect(await loadPairedDevicePairingStoreRecordReadOnly(c.identity.deviceId)).toEqual({
            ...before,
            publicKey: replacementKey,
          });
          return;
        }
        case "live-token": {
          const rotated = structuredClone(fixture.config);
          assert(rotated.gateway?.auth);
          rotated.gateway.auth.token = randomUUID();
          await fixture.publish(rotated, c.signal);
          return;
        }
        case "live-fallback": {
          const before = resolveGatewayAuthForConfig({ config: fixture.config }).password;
          assert(before && fixture.config.gateway?.auth?.password === undefined);
          setTestEnvValue("OPENCLAW_GATEWAY_PASSWORD", randomUUID());
          expect(resolveGatewayAuthForConfig({ config: fixture.config }).password).not.toBe(before);
        }
      }
    },
    release: async () => {
      fallbackEnv?.restore();
      if (kind === "live-role") {
        await setCanonicalUserProfileRole(self.profile.id, "operator");
      }
    },
  };
}
