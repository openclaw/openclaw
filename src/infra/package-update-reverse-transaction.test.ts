import { expect, it, vi } from "vitest";
import type { PackageActivationRecord } from "./package-update-activation-journal.js";
import type { PackageActivationReverseBinding } from "./package-update-activation-reverse-schema.js";
import type { PackageReverseAuthority } from "./package-update-activation-reverse.js";
import { withPackageReverseTransaction } from "./package-update-reverse-transaction.js";
import type { PackageUpdateTransaction } from "./package-update-swap-contract.js";

// Controlled activation boundary; these tests qualify transaction lifetime and
// delegation, not source proof, executor admission, SQLite or file publication.
const binding = {} as PackageActivationReverseBinding;
const authority: PackageReverseAuthority = {
  assertCurrent: () => {},
  assertWritersSettled: () => {},
  validateTarget: async () => {},
  beforeStatePublication: () => {},
};
const assertion = () => {};
const status = {
  phase: "reverse-complete" as const,
  operationId: "operation",
  installKey: "/installation",
};
function deferred() {
  let resolve!: (value: typeof status) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<typeof status>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(legacyRollbackAllowed = true) {
  let active = true;
  let record = {
    phase: "publication-complete",
    descriptor: {
      operationId: "operation",
      originalRunId: "original",
      previous: { version: "1.0.0" },
      authority: { installKey: "/installation" },
    },
  } as PackageActivationRecord;
  const work = deferred();
  const settlement = deferred();
  const activation = {
    anchor: "/anchor",
    assertLegacyRollback: vi.fn(() => {
      if (!active) {
        throw new Error("original executor revoked");
      }
      if (!legacyRollbackAllowed) {
        throw new Error("Native generation requires reverse publication");
      }
    }),
    assertCurrent: vi.fn(() => {
      if (!active) {
        throw new Error("original executor revoked");
      }
    }),
    assertReverseCurrent: vi.fn(() => {
      if (!active) {
        throw new Error("original executor revoked");
      }
    }),
    journal: { read: () => structuredClone(record) },
    reverse: vi.fn(() => work.promise),
    prepareReverse: vi.fn(async () => ({
      status,
      binding: {} as never,
    })),
    settleReverse: vi.fn(() => settlement.promise),
    resourceCustody: vi.fn(async () => ({
      packageResources: [],
      stagingParent: () => "/original-parent",
    })),
    verifyCompletion: vi.fn(async () => ({ ...status, publishedState: {} })),
    commitCompletion: vi.fn(async () => status),
  } as unknown as NonNullable<Parameters<typeof withPackageReverseTransaction>[1]>;
  const legacy = {
    backupRoot: "/backup",
    rollback: vi.fn(async () => ({
      name: "package-rollback",
      command: "restore",
      cwd: "/installation",
      durationMs: 0,
      exitCode: 0,
      stdoutTail: null,
      stderrTail: null,
      activePackageRoot: "/installation",
    })),
    complete: vi.fn(async () => undefined),
  } satisfies PackageUpdateTransaction;
  const transaction = withPackageReverseTransaction(legacy, activation);
  return {
    work,
    settlement,
    activation,
    legacy,
    transaction,
    reverse: transaction.reversePublication!,
    revoke: () => {
      active = false;
    },
    pin: () => {
      record = {
        ...record,
        phase: "reverse-in-progress",
        descriptor: { ...record.descriptor, reverse: binding },
      };
    },
  };
}

it("leaves transactions without native activation on their original path", async () => {
  const f = fixture();
  expect(withPackageReverseTransaction(f.legacy, undefined)).toBe(f.legacy);
  await f.transaction.rollback(assertion);
  expect(f.legacy.rollback).toHaveBeenCalledExactlyOnceWith(assertion);
  expect(() => f.reverse.publish(binding, authority)).toThrow("rollback has started");
});

it("joins issued publication before returning retention and never delegates unverified cleanup", async () => {
  const f = fixture();
  const publishing = f.reverse.publish(binding, authority);
  expect(() => f.reverse.publish(binding, authority)).toThrow("already started");
  const completion = f.transaction.complete({ activationVerified: true }, assertion);
  let returned = false;
  void completion.then(() => {
    returned = true;
  });
  await Promise.resolve();
  expect(returned).toBe(false);
  expect(f.legacy.complete).not.toHaveBeenCalled();
  f.work.resolve(status);
  await publishing;
  expect(await completion).toMatchObject({ name: "package-backup-retention", exitCode: 1 });
  expect(f.legacy.complete).not.toHaveBeenCalled();
});

it("joins both issued phases before delegating the original completion policy", async () => {
  const f = fixture();
  const publishing = f.reverse.publish(binding, authority);
  const settling = f.reverse.settle(authority);
  expect(f.reverse.settle(authority)).toBe(settling);
  const outcome = { activationVerified: false };
  const completion = f.transaction.complete(outcome, assertion);
  f.work.resolve(status);
  await publishing;
  await Promise.resolve();
  expect(f.activation.settleReverse).toHaveBeenCalledTimes(1);
  expect(f.legacy.complete).not.toHaveBeenCalled();
  f.settlement.resolve(status);
  await settling;
  await completion;
  expect(f.legacy.complete).toHaveBeenCalledExactlyOnceWith(outcome, assertion);
  expect(() => f.reverse.publish(binding, authority)).toThrow("settlement");
});

it("waits for issued work after original executor revocation and refuses replacement cleanup authority", async () => {
  const f = fixture();
  const publishing = f.reverse.publish(binding, authority);
  f.revoke();
  const completion = f.transaction.complete({ activationVerified: true }, assertion);
  const rejected = expect(completion).rejects.toThrow("original executor revoked");
  let returned = false;
  void completion.then(
    () => {
      returned = true;
    },
    () => {
      returned = true;
    },
  );
  await Promise.resolve();
  expect(returned).toBe(false);
  f.work.resolve(status);
  await publishing;
  await rejected;
  expect(f.legacy.complete).not.toHaveBeenCalled();
});

it("allows a proved pre-pin refusal to retry but retains committed failure for its own recovery", async () => {
  const f = fixture();
  const first = f.reverse.publish(binding, authority);
  const refusal = expect(first).rejects.toThrow("target refused");
  f.work.reject(new Error("target refused"));
  await refusal;
  const retry = deferred();
  vi.mocked(f.activation.reverse).mockReturnValueOnce(retry.promise);
  const second = f.reverse.publish(binding, authority);
  f.pin();
  const failure = expect(second).rejects.toThrow("after durable pin");
  retry.reject(new Error("after durable pin"));
  await failure;
  expect(() => f.reverse.publish(binding, authority)).toThrow("already started");
  expect(await f.transaction.rollback(assertion)).toMatchObject({
    name: "package-rollback",
    exitCode: 1,
  });
  expect(f.legacy.rollback).not.toHaveBeenCalled();
});

it("revokes retained resource selection capability when the original lifetime closes", async () => {
  const f = fixture();
  const selection = f.reverse.selection();
  selection.previous.version = "forged";
  expect(f.reverse.selection().previous.version).toBe("1.0.0");
  const custody = await f.reverse.resourceCustody(authority);
  expect(custody.stagingParent("/state")).toBe("/original-parent");
  await f.transaction.complete({ activationVerified: false }, assertion);
  expect(() => custody.stagingParent("/state")).toThrow("settlement");
  expect(() => f.reverse.selection()).toThrow("settlement");
});

it("requires settlement before completion readback and rechecks authority across its await", async () => {
  const f = fixture();
  await expect(f.reverse.verifyCompletion(binding, authority)).rejects.toThrow(
    "exhaustive settlement",
  );
  const publishing = f.reverse.publish(binding, authority);
  const settling = f.reverse.settle(authority);
  f.work.resolve(status);
  f.settlement.resolve(status);
  await publishing;
  await settling;
  vi.mocked(f.activation.verifyCompletion).mockImplementationOnce(async () => {
    f.revoke();
    return { ...status, publishedState: {} } as Awaited<
      ReturnType<typeof f.activation.verifyCompletion>
    >;
  });
  await expect(f.reverse.verifyCompletion(binding, authority)).rejects.toThrow(
    "original executor revoked",
  );
});

it("keeps repeated completion on the native cached retirement path", async () => {
  const f = fixture();
  f.legacy.complete.mockImplementation(async () => {
    vi.mocked(f.activation.assertCurrent).mockImplementation(() => {
      throw new Error("activation journal has been retired");
    });
  });
  const outcome = { activationVerified: true };
  await f.transaction.complete(outcome, assertion);
  await f.transaction.complete(outcome, assertion);
  expect(f.legacy.complete).toHaveBeenCalledTimes(2);
  expect(() => f.reverse.selection()).toThrow("settlement");
});

it("keeps native reverse publication usable after legacy rollback is refused", async () => {
  const f = fixture(false);
  const replacementAssertion = vi.fn();
  await expect(f.transaction.rollback(replacementAssertion)).rejects.toThrow(
    "Native generation requires reverse publication",
  );
  expect(f.legacy.rollback).not.toHaveBeenCalled();
  expect(replacementAssertion).not.toHaveBeenCalled();
  expect(f.reverse.selection()).toMatchObject({ originalRunId: "original" });
  const publishing = f.reverse.publish(binding, authority);
  f.work.resolve(status);
  await expect(publishing).resolves.toEqual(status);
});

it("captures queued settlement authority before waiting for publication", async () => {
  const f = fixture();
  let active = true;
  const original = vi.fn(() => {
    if (!active) {
      throw new Error("queued original maintenance closed");
    }
  });
  const guard: PackageReverseAuthority = {
    ...authority,
    assertCurrent: original,
    assertWritersSettled: original,
  };
  const replacement = vi.fn();
  let settled = false;
  vi.mocked(f.activation.settleReverse).mockImplementationOnce(async (captured) => {
    captured.assertCurrent();
    captured.assertWritersSettled();
    settled = true;
    return status;
  });
  const publishing = f.reverse.publish(binding, guard);
  const settling = f.reverse.settle(guard);
  const refused = expect(settling).rejects.toThrow("queued original maintenance closed");
  guard.assertCurrent = replacement;
  guard.assertWritersSettled = replacement;
  active = false;
  f.work.resolve(status);
  await publishing;
  await refused;
  expect(settled).toBe(false);
  expect(replacement).not.toHaveBeenCalled();
  expect(await f.transaction.complete({ activationVerified: true }, assertion)).toMatchObject({
    name: "package-backup-retention",
    exitCode: 1,
  });
  expect(f.legacy.complete).not.toHaveBeenCalled();
});
