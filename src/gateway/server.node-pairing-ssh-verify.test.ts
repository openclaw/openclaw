import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { writeConfigFile } from "../config/config.js";
import { getRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { GatewayNodePairingConfig } from "../config/types.gateway.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
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

const pendingPairingCleanups = new Set<() => Promise<void>>();
const pendingPairingAttempts = new Set<Promise<void>>();
afterEach(async () => {
  // Runner timeouts do not unwind a body waiting for approval or its pairing lock.
  const outcomes = await Promise.allSettled([...pendingPairingCleanups].map((close) => close()));
  await Promise.allSettled(pendingPairingAttempts);
  const errors = outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason] : [],
  );
  if (errors.length) {
    throw new AggregateError(errors, "SSH pairing timeout cleanup failed");
  }
});

// Observe the real verifier and approval owner so assertions and teardown join
// their actual work, without replacing authorization or waiting on a timer.
function observePairingWork(release?: () => void | Promise<void>) {
  const waiting = new AbortController();
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
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= runQaGatewayFixture(
      async () => {
        waiting.abort();
        await release?.();
      },
      settle,
      () => {
        rootWork.mockRestore();
        verification.mockRestore();
        approval.mockRestore();
        pendingPairingCleanups.delete(close);
      },
    ));
  pendingPairingCleanups.add(close);
  const wait = <T>(pending: Promise<T>, timeoutMs: number, message: string) =>
    withTestTimeout(racePromiseWithAbortSignal(pending, waiting.signal), timeoutMs, message);
  return {
    approval,
    verification,
    waitForApproval: () =>
      wait(called.promise, 1_000, "timed out waiting for SSH approval dispatch"),
    waitForApprovalResult: () =>
      wait(
        called.promise.then(({ result }) => result),
        8_000,
        "timed out waiting for ssh-verified device approval",
      ),
    settle,
    close,
  };
}

type SshVerifyConfig = Exclude<GatewayNodePairingConfig["sshVerify"], boolean | undefined>;

function createSshVerifyConfig(lanIp: string, overrides: SshVerifyConfig = {}): SshVerifyConfig {
  return { cidrs: [`${lanIp}/32`], ...overrides };
}

async function pendingFor(deviceId: string) {
  return (await devicePairing.listDevicePairing()).pending.filter(
    (entry) => entry.deviceId === deviceId,
  );
}

function probeIdentity(
  loaded: { identity: { deviceId: string }; publicKey: string },
  publicKey = loaded.publicKey,
  prefix = "",
): NodeIdentityProbeResult {
  return {
    status: "ok",
    stdout: `${prefix}${JSON.stringify({ deviceId: loaded.identity.deviceId, publicKey })}\n`,
  };
}

function expectRetry(res: { ok: boolean; error?: { details?: unknown } }) {
  expect(res).toMatchObject({
    ok: false,
    error: { details: { recommendedNextStep: "wait_then_retry", pauseReconnect: false } },
  });
}

describeWithLanNodePairingServer("gateway ssh-verified node pairing auto-approve", (attempt) => {
  const runPairing = async (
    identityName: string,
    run: Parameters<typeof attempt>[0]["run"],
    sshVerify?: false,
  ) => {
    const pending = attempt({
      identityName,
      run,
      configure: async (lanIp) => {
        await writeConfigFile({
          gateway: { nodes: { pairing: { sshVerify: sshVerify ?? createSshVerifyConfig(lanIp) } } },
        });
      },
    });
    pendingPairingAttempts.add(pending);
    try {
      await pending;
    } finally {
      pendingPairingAttempts.delete(pending);
    }
  };

  beforeEach(() => {
    // Each case uses a distinct identityName, matching the host+device cooldown key.
    probeMock.mockReset();
  });

  test.each([
    { name: "disabled while approval waits for lock", lockApproval: true, next: false },
    { name: "SSH user changed", lockApproval: false, next: { user: "replacement-user" } },
  ] satisfies {
    name: string;
    lockApproval: boolean;
    next: GatewayNodePairingConfig["sshVerify"];
  }[])("keeps pairing pending when $name", async ({ name, lockApproval, next }) => {
    await runPairing(
      `ssh-policy-${name.replaceAll(" ", "-")}`,
      async ({ lanIp, loaded, connectNode }) => {
        const probe = createDeferred<NodeIdentityProbeResult>();
        const lock = createDeferred();
        const locked = createDeferred();
        let lockWork: Promise<void> | undefined;
        const work = observePairingWork(async () => {
          lock.resolve();
          probe.resolve({ status: "timeout" });
          await lockWork;
        });
        const matched = probeIdentity(loaded);
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
            probe.resolve(matched);
            await work.waitForApproval();
            expect(work.approval).toHaveBeenCalledOnce();
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
          probe.resolve(matched);
          lock.resolve();
          await lockWork;
          const { result } = await work.waitForApproval();
          expect(work.approval).toHaveBeenCalledOnce();
          await result;
          expect(await devicePairing.getPairedDevice(loaded.identity.deviceId)).toBeNull();
          expect(await pendingFor(loaded.identity.deviceId)).toContainEqual(
            expect.objectContaining({ deviceId: loaded.identity.deviceId }),
          );
        } finally {
          await work.close();
        }
      },
    );
  });

  test("approves device pairing and the first capability surface after reconnect", async () => {
    await runPairing("ssh-verify-key-match", async ({ lanIp, loaded, connectNode }) => {
      const probe = createDeferred<NodeIdentityProbeResult>();
      const work = observePairingWork(() => {
        probe.resolve({ status: "timeout" });
      });
      const matched = probeIdentity(loaded, loaded.publicKey, "motd noise\n");
      probeMock.mockImplementation(() => probe.promise);
      await runQaGatewayFixture(async () => {
        const first = await connectNode();
        expect(probeMock).toHaveBeenCalledOnce();
        expectRetry(first);
        expect(await devicePairing.getPairedDevice(loaded.identity.deviceId)).toBeNull();
        expect(await pendingFor(loaded.identity.deviceId)).toContainEqual(
          expect.objectContaining({
            deviceId: loaded.identity.deviceId,
            publicKey: loaded.publicKey,
          }),
        );
        probe.resolve(matched);
        const result = await work.waitForApprovalResult();
        expect(result?.status).toBe("approved");
        expect(await devicePairing.getPairedDevice(loaded.identity.deviceId)).toMatchObject({
          approvedVia: "ssh-verified",
          publicKey: loaded.publicKey,
        });
        expect(probeMock).toHaveBeenCalledWith(expect.objectContaining({ host: lanIp }));

        const second = await connectNode();
        expect(second).toMatchObject({ ok: true, payload: { type: "hello-ok" } });
        // Machine ownership also approves the first capability surface.
        const record = await devicePairing.getPairedDevice(loaded.identity.deviceId);
        expect(record?.nodeSurface).toBeDefined();
        expect(record?.pendingNodeSurface).toBeUndefined();
      }, work.close);
    });
  });

  test("does not ssh-approve a pending request that carries scopes from an earlier attempt", async () => {
    await runPairing("ssh-verify-scoped-refresh", async ({ loaded, connectNode }) => {
      // A scopeless reconnect must not smuggle the earlier request's scopes.
      await devicePairing.requestDevicePairing({
        deviceId: loaded.identity.deviceId,
        publicKey: loaded.publicKey,
        role: "node",
        roles: ["node"],
        scopes: ["node.exec"],
      });
      probeMock.mockImplementation(async () => probeIdentity(loaded));

      const res = await connectNode();
      expect(res.ok).toBe(false);

      // Eligibility is decided before the handshake response.
      expect(probeMock).not.toHaveBeenCalled();
      expect(await devicePairing.getPairedDevice(loaded.identity.deviceId)).toBeNull();
    });
  });

  test("leaves the pairing pending when the remote identity does not match", async () => {
    await runPairing("ssh-verify-key-mismatch", async ({ loaded, connectNode }) => {
      probeMock.mockImplementation(async () =>
        probeIdentity(loaded, "not-the-expected-device-key"),
      );

      const work = observePairingWork();
      await runQaGatewayFixture(async () => {
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
        expect(await pendingFor(loaded.identity.deviceId)).toHaveLength(1);
      }, work.close);
    });
  });

  test("sshVerify: false disables the probe while awaiting manual approval", async () => {
    await runPairing(
      "ssh-verify-disabled",
      async ({ loaded, connectNode }) => {
        const res = await connectNode();
        expect(res.error?.message).toContain("pairing required");
        const pending = await pendingFor(loaded.identity.deviceId);
        expect(pending).toHaveLength(1);
        expect(pending[0]?.silent).toBe(false);
        expectRetry(res);
        expect(probeMock).not.toHaveBeenCalled();
        expect(await devicePairing.getPairedDevice(loaded.identity.deviceId)).toBeNull();
      },
      false,
    );
  });
});
