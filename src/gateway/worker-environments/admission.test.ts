import { beforeEach, describe, expect, it } from "vitest";
import type { WorkerConnectParams } from "../../../packages/gateway-protocol/src/index.js";
import { sameWorkerBuild } from "../../worker/worker-build-identity.js";
import { admitWorkerConnection, validateWorkerConnectionIdentity } from "./admission.js";
import { hashWorkerCredential, type WorkerCredentialRecord } from "./credential.js";
import type { WorkerEnvironmentRecord, WorkerEnvironmentStore } from "./store.js";
import { workerCredential } from "./store.test-support.js";

const BUNDLE_HASH = "a".repeat(64);
const CREDENTIAL = ["worker", "credential", "fixture"].join("-");
const OTHER_CREDENTIAL = ["other", "credential", "fixture"].join("-");
const RECEIPT = {
  bundleHash: BUNDLE_HASH,
  openclawVersion: "2026.7.11",
  protocolFeatures: ["worker-heartbeat-v1"],
};

describe("worker admission", () => {
  let environment: WorkerEnvironmentRecord;
  let credential: WorkerCredentialRecord;
  let nowMs: number;
  let store: WorkerEnvironmentStore;

  beforeEach(() => {
    nowMs = 1_000;
    environment = {
      environmentId: "worker-1",
      state: "ready",
      ownerEpoch: 1,
      destroyRequestedAtMs: null,
      bootstrapReceipt: RECEIPT,
    } as WorkerEnvironmentRecord;
    credential = {
      ...workerCredential(hashWorkerCredential(CREDENTIAL)),
      environmentId: environment.environmentId,
      bundleHash: BUNDLE_HASH,
      ownerEpoch: 1,
      deliveredAtMs: null,
    };
    store = {
      get: (id: string) => (id.trim() === environment.environmentId ? environment : undefined),
      getCredential: (id: string) =>
        id.trim() === credential.environmentId ? credential : undefined,
      findCredentialByHash: (hash: string) =>
        hash === credential.credentialHash ? credential : undefined,
    } as WorkerEnvironmentStore;
  });

  type Admission = WorkerConnectParams["admission"];
  type AdmissionOverrides = Partial<Omit<Admission, "sessionId" | "runId">> &
    ({ sessionId?: null; runId?: null } | { sessionId: string; runId: string });
  const admit = (
    overrides: AdmissionOverrides = {},
    options: { expectedBuild?: typeof RECEIPT; allowExpiredCredential?: boolean } = {},
  ) =>
    admitWorkerConnection({
      store,
      admission: {
        environmentId: "worker-1",
        credential: CREDENTIAL,
        ownerEpoch: 1,
        rpcSetVersion: 1,
        handshake: RECEIPT,
        sessionId: null,
        runId: null,
        ...overrides,
      },
      expectedBuild: RECEIPT,
      nowMs,
      ...options,
    });

  it("verifies and admits the complete current build identity", () => {
    expect(sameWorkerBuild(RECEIPT, RECEIPT)).toBe(true);
    expect(admit()).toMatchObject({
      ok: true,
      identity: {
        environmentId: "worker-1",
        sessionId: null,
        runId: null,
        ownerEpoch: 1,
        rpcSetVersion: 1,
        protocolFeatures: ["worker-heartbeat-v1"],
        credentialExpiresAtMs: 2_000,
      },
    });
  });

  it.each([
    ["invalid-credential", { credential: OTHER_CREDENTIAL }],
    ["environment-mismatch", { environmentId: "worker-other" }],
    ["environment-mismatch", { environmentId: " worker-1 " }],
    ["bundle-mismatch", { handshake: { ...RECEIPT, bundleHash: "b".repeat(64) } }],
    ["version-mismatch", { handshake: { ...RECEIPT, openclawVersion: "other" } }],
    ["placement-mismatch", { sessionId: "session-other", runId: "run-other" }],
    ["owner-epoch-mismatch", { ownerEpoch: 2 }],
    ["rpc-set-mismatch", { rpcSetVersion: 2 }],
    [
      "protocol-features-mismatch",
      { handshake: { ...RECEIPT, protocolFeatures: ["different-feature"] } },
    ],
  ] satisfies Array<[string, AdmissionOverrides]>)("rejects %s", (reason, overrides) => {
    expect(admit(overrides)).toEqual({ ok: false, reason });
  });

  it("rejects expiry, unavailable state, and the previous gateway build", () => {
    nowMs = credential.expiresAtMs;
    expect(admit()).toEqual({ ok: false, reason: "credential-expired" });
    expect(admit({}, { allowExpiredCredential: true })).toMatchObject({ ok: true });
    nowMs = 1_000;
    environment = { ...environment, destroyRequestedAtMs: nowMs };
    expect(admit()).toEqual({ ok: false, reason: "environment-unavailable" });
    environment = { ...environment, destroyRequestedAtMs: null };
    expect(admit({}, { expectedBuild: { ...RECEIPT, bundleHash: "b".repeat(64) } })).toEqual({
      ok: false,
      reason: "bundle-mismatch",
    });
  });

  it("fences a live connection after credential rotation", () => {
    const admitted = admit();
    if (!admitted.ok) {
      throw new Error("fixture admission failed");
    }
    credential = { ...credential, credentialHash: hashWorkerCredential(OTHER_CREDENTIAL) };
    expect(validateWorkerConnectionIdentity({ store, identity: admitted.identity, nowMs })).toBe(
      "credential-replaced",
    );
  });
});
