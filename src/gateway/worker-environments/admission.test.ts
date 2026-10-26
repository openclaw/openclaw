import { expect, it } from "vitest";
import type { WorkerConnectParams } from "../../../packages/gateway-protocol/src/index.js";
import { admitWorkerConnection } from "./admission.js";
import { hashWorkerCredential } from "./credential.js";
import type { WorkerEnvironmentRecord, WorkerEnvironmentStore } from "./store.js";
import { workerCredential } from "./store.test-support.js";

const CREDENTIAL = ["worker", "credential", "fixture"].join("-");
const RECEIPT = {
  bundleHash: "a".repeat(64),
  openclawVersion: "2026.7.11",
  protocolFeatures: ["worker-heartbeat-v1"],
};
const STALE_RECEIPT = { ...RECEIPT, bundleHash: "b".repeat(64) };
type Admission = WorkerConnectParams["admission"];
type AdmissionOverrides = Partial<Omit<Admission, "sessionId" | "runId">> &
  ({ sessionId?: null; runId?: null } | { sessionId: string; runId: string });

function fixture() {
  const owner = { environmentId: "worker-1", ownerEpoch: 1 };
  const environment = {
    ...owner,
    state: "ready",
    destroyRequestedAtMs: null,
    bootstrapReceipt: RECEIPT,
  } as WorkerEnvironmentRecord;
  const credential = {
    ...owner,
    ...workerCredential(hashWorkerCredential(CREDENTIAL)),
    bundleHash: RECEIPT.bundleHash,
    deliveredAtMs: null,
  };
  const store = {
    get: (id: string) => (id.trim() === environment.environmentId ? environment : undefined),
    getCredential: (id: string) =>
      id.trim() === credential.environmentId ? credential : undefined,
    findCredentialByHash: (hash: string) =>
      hash === credential.credentialHash ? credential : undefined,
  } as WorkerEnvironmentStore;
  const params: Parameters<typeof admitWorkerConnection>[0] = {
    store,
    admission: {
      ...owner,
      credential: CREDENTIAL,
      rpcSetVersion: 1,
      handshake: RECEIPT,
      sessionId: null,
      runId: null,
    },
    expectedBuild: RECEIPT,
    nowMs: 1_000,
  };
  const admit = (overrides: Partial<typeof params> = {}) =>
    admitWorkerConnection({ ...params, ...overrides });
  const reject = (reason: string, overrides?: Partial<typeof params>) =>
    expect(admit(overrides)).toEqual({ ok: false, reason });
  return { environment, credential, params, admit, reject };
}

it.each([
  ["environment-mismatch", { environmentId: "worker-other" }],
  ["environment-mismatch", { environmentId: " worker-1 " }],
  ["bundle-mismatch", { handshake: STALE_RECEIPT }],
  ["version-mismatch", { handshake: { ...RECEIPT, openclawVersion: "other" } }],
  ["placement-mismatch", { sessionId: "session-other", runId: "run-other" }],
  ["owner-epoch-mismatch", { ownerEpoch: 2 }],
  ["rpc-set-mismatch", { rpcSetVersion: 2 }],
  ["protocol-features-mismatch", { handshake: { ...RECEIPT, protocolFeatures: ["other"] } }],
] satisfies Array<[string, AdmissionOverrides]>)("rejects %s", (reason, overrides) => {
  const { reject, params } = fixture();
  reject(reason, { admission: { ...params.admission, ...overrides } });
});

it("rejects expiry, unavailable state, and the previous gateway build", () => {
  const { admit, reject, params, credential, environment } = fixture();
  params.nowMs = credential.expiresAtMs;
  reject("credential-expired");
  expect(admit({ allowExpiredCredential: true })).toMatchObject({ ok: true });
  params.nowMs = 1_000;
  environment.destroyRequestedAtMs = params.nowMs;
  reject("environment-unavailable");
  environment.destroyRequestedAtMs = null;
  reject("bundle-mismatch", { expectedBuild: STALE_RECEIPT });
});
