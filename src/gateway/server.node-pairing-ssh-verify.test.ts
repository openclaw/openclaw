// SSH-verified node pairing e2e: real gateway server on the LAN self-connect
// harness, with the SSH probe runtime mocked at the module boundary.
import { beforeEach, expect, test, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { writeConfigFile } from "../config/config.js";
import { getRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { GatewayNodePairingConfig } from "../config/types.gateway.js";
import * as pairingApprovals from "../infra/device-pairing-approval.js";
import { withDevicePairingLock } from "../infra/device-pairing-lock.js";
import * as devicePairing from "../infra/device-pairing.js";
import * as workAdmission from "../process/gateway-work-admission.js";
import * as sshVerification from "./node-pairing-ssh-verify.js";
import type {
  NodeIdentityProbeParams,
  NodeIdentityProbeResult,
} from "./node-pairing-ssh-verify.runtime.js";
import { installGatewayTestHooks } from "./test-helpers.js";
import { describeWithLanNodePairingServer } from "./test-helpers.lan-pairing.js";

const probeMock = vi.hoisted(() =>
  vi.fn<(params: NodeIdentityProbeParams) => Promise<NodeIdentityProbeResult>>(),
);

vi.mock("./node-pairing-ssh-verify.runtime.js", () => ({
  runNodeIdentityProbe: (params: NodeIdentityProbeParams) => probeMock(params),
}));

vi.mock("../skills/runtime/remote.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../skills/runtime/remote.js")>()),
  // Pairing coverage does not need the unrelated 5s connect-time bin refresh.
  refreshRemoteNodeBins: vi.fn(async () => {}),
}));

installGatewayTestHooks({ scope: "suite" });

// Observe the real verifier and approval owner so assertions and teardown join
// their actual work, without replacing authorization or waiting on a timer.
function observePairingWork() {
  const approve = pairingApprovals.approveDevicePairing;
  const called = createDeferred<{ result: ReturnType<typeof approve> }>();
  const approval = vi
    .spyOn(pairingApprovals, "approveDevicePairing")
    .mockImplementation((...args) => {
      const result = approve(...args);
      called.resolve({ result });
      return result;
    });
  const verification = vi.spyOn(sshVerification, "startNodePairingSshVerify");
  const rootWork = vi.spyOn(workAdmission, "runWithGatewayIndependentRootWorkAdmission");
  const settle = async () => {
    const outcomes: PromiseSettledResult<unknown>[] = await Promise.allSettled(
      verification.mock.results.flatMap((result) =>
        result.type === "return" && result.value ? [result.value.done] : [],
      ),
    );
    outcomes.push(
      ...(await Promise.allSettled(
        approval.mock.results.flatMap((result) => (result.type === "return" ? [result.value] : [])),
      )),
      ...(await Promise.allSettled(
        rootWork.mock.results.flatMap((result, index) =>
          result.type === "return" && rootWork.mock.calls[index]?.[1] === "ws:preauth"
            ? [result.value]
            : [],
        ),
      )),
    );
    const errors = outcomes.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, "SSH pairing work failed");
    }
  };
  return {
    approval,
    verification,
    called: called.promise,
    settle,
    async close() {
      try {
        await settle();
      } finally {
        rootWork.mockRestore();
        verification.mockRestore();
        approval.mockRestore();
      }
    },
  };
}

type PairingRequiredDetails = {
  code?: string;
  recommendedNextStep?: string;
  pauseReconnect?: boolean;
};

type SshVerifyConfig = Exclude<GatewayNodePairingConfig["sshVerify"], boolean | undefined>;

function createSshVerifyConfig(lanIp: string, overrides: SshVerifyConfig = {}): SshVerifyConfig {
  return { cidrs: [`${lanIp}/32`], ...overrides };
}

describeWithLanNodePairingServer("gateway ssh-verified node pairing auto-approve", (attempt) => {
  const attemptWithSshVerify: typeof attempt = async (params) => {
    const configure = params.configure;
    await attempt({
      ...params,
      configure: async (lanIp) => {
        await writeConfigFile({
          gateway: { nodes: { pairing: { sshVerify: createSshVerifyConfig(lanIp) } } },
        });
        await configure?.(lanIp);
      },
    });
  };

  beforeEach(() => {
    // Each case uses a distinct identityName, matching the host+device cooldown key.
    probeMock.mockReset();
  });

  test.each([
    { name: "disabled during probe", lockApproval: false, next: false },
    { name: "disabled while approval waits for lock", lockApproval: true, next: false },
    { name: "SSH user changed", lockApproval: false, next: { user: "replacement-user" } },
    { name: "SSH identity changed", lockApproval: false, next: { identity: "/keys/replacement" } },
    { name: "SSH scope narrowed", lockApproval: false, next: { cidrs: ["203.0.113.0/24"] } },
    { name: "SSH timeout changed", lockApproval: false, next: { timeoutMs: 300 } },
  ] satisfies {
    name: string;
    lockApproval: boolean;
    next: GatewayNodePairingConfig["sshVerify"];
  }[])("keeps pairing pending when $name", async ({ name, lockApproval, next }) => {
    await attemptWithSshVerify({
      identityName: `ssh-policy-${name.replaceAll(" ", "-")}`,
      run: async ({ lanIp, loaded, connectNode }) => {
        const probe = createDeferred<NodeIdentityProbeResult>();
        const lock = createDeferred();
        const locked = createDeferred();
        let lockWork: Promise<void> | undefined;
        const work = observePairingWork();
        const approval = work.approval;
        probeMock.mockImplementation(() => probe.promise);
        try {
          const first = await connectNode();
          expect(first.ok).toBe(false);
          expect(probeMock).toHaveBeenCalledOnce();
          if (lockApproval) {
            lockWork = withDevicePairingLock(async () => {
              locked.resolve();
              await lock.promise;
            });
            await locked.promise;
            probe.resolve({
              status: "ok",
              stdout: JSON.stringify({
                deviceId: loaded.identity.deviceId,
                publicKey: loaded.publicKey,
              }),
            });
            await work.called;
            expect(approval).toHaveBeenCalledOnce();
          }
          const current = getRuntimeConfigSnapshot();
          expect(current).not.toBeNull();
          setRuntimeConfigSnapshot({
            ...current,
            gateway: {
              ...current?.gateway,
              nodes: {
                ...current?.gateway?.nodes,
                pairing: {
                  sshVerify: typeof next === "object" ? createSshVerifyConfig(lanIp, next) : next,
                },
              },
            },
          });
          probe.resolve({
            status: "ok",
            stdout: JSON.stringify({
              deviceId: loaded.identity.deviceId,
              publicKey: loaded.publicKey,
            }),
          });
          lock.resolve();
          await lockWork;
          const { result } = await work.called;
          expect(approval).toHaveBeenCalledOnce();
          await result;
          expect(await devicePairing.getPairedDevice(loaded.identity.deviceId)).toBeNull();
          expect((await devicePairing.listDevicePairing()).pending).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ deviceId: loaded.identity.deviceId }),
            ]),
          );
        } finally {
          lock.resolve();
          probe.resolve({ status: "timeout" });
          await lockWork;
          await work.close();
        }
      },
    });
  });

  test.each(["after rejection", "during handshake"] as const)(
    "approves device pairing and the first capability surface when SSH finishes %s",
    async (timing) => {
      await attemptWithSshVerify({
        identityName: `ssh-verify-key-match-${timing.replaceAll(" ", "-")}`,
        run: async ({ lanIp, loaded, connectNode }) => {
          const probe = createDeferred<NodeIdentityProbeResult>();
          const work = observePairingWork();
          const matched: NodeIdentityProbeResult = {
            status: "ok",
            stdout: `motd noise\n{"deviceId":"${loaded.identity.deviceId}","publicKey":"${loaded.publicKey}"}\n`,
          };
          probeMock.mockImplementation(() => probe.promise);
          const readPairing = devicePairing.listDevicePairing;
          const reread =
            timing === "during handshake"
              ? vi.spyOn(devicePairing, "listDevicePairing").mockImplementationOnce(async () => {
                  const pendingSnapshot = await readPairing();
                  // Let the real SSH approval commit after the pending snapshot,
                  // before the handshake revalidates current device authority.
                  probe.resolve(matched);
                  const { result } = await work.called;
                  expect((await result)?.status).toBe("approved");
                  return pendingSnapshot;
                })
              : undefined;
          let bodyFailure: { error: unknown } | undefined;
          try {
            const first = await connectNode();
            expect(probeMock).toHaveBeenCalledOnce();
            if (timing === "after rejection") {
              expect(first.ok).toBe(false);
              const details = first.error?.details as PairingRequiredDetails | undefined;
              expect(details?.recommendedNextStep).toBe("wait_then_retry");
              expect(details?.pauseReconnect).toBe(false);
              expect(await devicePairing.getPairedDevice(loaded.identity.deviceId)).toBeNull();
              expect((await devicePairing.listDevicePairing()).pending).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({
                    deviceId: loaded.identity.deviceId,
                    publicKey: loaded.publicKey,
                  }),
                ]),
              );
              probe.resolve(matched);
            } else {
              expect(reread).toHaveBeenCalledOnce();
              expect(first).toMatchObject({ ok: true, payload: { type: "hello-ok" } });
            }
            const { result } = await work.called;
            expect((await result)?.status).toBe("approved");
            const paired = await devicePairing.getPairedDevice(loaded.identity.deviceId);
            expect(paired?.approvedVia).toBe("ssh-verified");
            expect(paired?.publicKey).toBe(loaded.publicKey);
            expect(probeMock).toHaveBeenCalledWith(expect.objectContaining({ host: lanIp }));

            const second = await connectNode();
            expect(second.ok).toBe(true);
            expect((second.payload as { type?: unknown } | undefined)?.type).toBe("hello-ok");
            // Machine ownership also approves the first capability surface.
            const record = await devicePairing.getPairedDevice(loaded.identity.deviceId);
            expect(record?.nodeSurface).toBeDefined();
            expect(record?.pendingNodeSurface).toBeUndefined();
          } catch (error) {
            bodyFailure = { error };
          }
          // Release a failed assertion's probe and join the real approval tail
          // before the next case resets configuration or pairing state.
          probe.resolve({ status: "timeout" });
          reread?.mockRestore();
          try {
            await work.close();
          } catch (cleanupError) {
            if (bodyFailure) {
              throw new AggregateError(
                [bodyFailure.error, cleanupError],
                "SSH pairing fixture and cleanup failed",
                { cause: cleanupError },
              );
            }
            throw cleanupError;
          }
          if (bodyFailure) {
            throw bodyFailure.error;
          }
        },
      });
    },
  );

  test("does not ssh-approve a pending request that carries scopes from an earlier attempt", async () => {
    await attemptWithSshVerify({
      identityName: "ssh-verify-scoped-refresh",
      run: async ({ loaded, connectNode }) => {
        // Seed a scoped pending request (as an earlier interactive attempt
        // would). The scopeless reconnect below refreshes this same request in
        // place, so approving it would smuggle the scope past the fresh
        // scopeless boundary. A matching probe would approve if reached.
        await devicePairing.requestDevicePairing({
          deviceId: loaded.identity.deviceId,
          publicKey: loaded.publicKey,
          role: "node",
          roles: ["node"],
          scopes: ["node.exec"],
        });
        probeMock.mockImplementation(async () => ({
          status: "ok",
          stdout: `{"deviceId":"${loaded.identity.deviceId}","publicKey":"${loaded.publicKey}"}\n`,
        }));

        const res = await connectNode();
        expect(res.ok).toBe(false);

        // The scoped pending request disqualifies ssh-verify entirely: no probe
        // runs and the device is never auto-approved.
        // Probe eligibility is decided before this handshake response.
        expect(probeMock).not.toHaveBeenCalled();
        expect(await devicePairing.getPairedDevice(loaded.identity.deviceId)).toBeNull();
      },
    });
  });

  test("leaves the pairing pending when the remote identity does not match", async () => {
    await attemptWithSshVerify({
      identityName: "ssh-verify-key-mismatch",
      run: async ({ loaded, connectNode }) => {
        // A different key than the pending request: assembled from words so the
        // fixture is not a high-entropy blob (keeps review bundlers happy).
        const wrongKey = ["not", "the", "expected", "device", "key"].join("-");
        probeMock.mockImplementation(async () => ({
          status: "ok",
          stdout: `{"deviceId":"${loaded.identity.deviceId}","publicKey":"${wrongKey}"}\n`,
        }));

        const work = observePairingWork();
        try {
          const res = await connectNode();
          expect(res.ok).toBe(false);
          expect(probeMock).toHaveBeenCalledOnce();
          expect(work.verification).toHaveBeenCalledOnce();
          const verification = work.verification.mock.results[0];
          if (verification?.type !== "return" || !verification.value) {
            throw new Error("expected the SSH verifier to start");
          }
          await expect(verification.value.done).resolves.toEqual({
            ok: false,
            reason: "identity-mismatch",
          });
          await work.settle();
          expect(await devicePairing.getPairedDevice(loaded.identity.deviceId)).toBeNull();
          const pending = (await devicePairing.listDevicePairing()).pending.filter(
            (entry) => entry.deviceId === loaded.identity.deviceId,
          );
          expect(pending).toHaveLength(1);
        } finally {
          await work.close();
        }
      },
    });
  });

  test("sshVerify: false disables the probe and keeps default reconnect pause behavior", async () => {
    await attemptWithSshVerify({
      identityName: "ssh-verify-disabled",
      configure: async () => {
        await writeConfigFile({
          gateway: { nodes: { pairing: { sshVerify: false } } },
        });
      },
      run: async ({ loaded, connectNode }) => {
        const res = await connectNode();
        expect(res.ok).toBe(false);
        const details = res.error?.details as PairingRequiredDetails | undefined;
        expect(details?.recommendedNextStep).toBeUndefined();
        expect(details?.pauseReconnect).toBeUndefined();
        expect(probeMock).not.toHaveBeenCalled();
        expect(await devicePairing.getPairedDevice(loaded.identity.deviceId)).toBeNull();
      },
    });
  });
});
