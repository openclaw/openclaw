import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { UpdateActivationTimeoutError } from "../cli/update-cli/update-command-activation.js";
import { createUpdateCommandAuthority } from "../cli/update-cli/update-command-authority.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import {
  assertUpdateWriteAuthority,
  createFreeBsdUpdateWriteAdmission,
} from "./update-freebsd-write-admission.js";

afterEach(() => vi.restoreAllMocks());
const create = () => withMockedPlatform("freebsd", () => createFreeBsdUpdateWriteAdmission()!);

it("does not create an admission on other platforms", () => {
  withMockedPlatform("linux", () => {
    expect(createFreeBsdUpdateWriteAdmission()).toBeUndefined();
  });
});

it("starts unadmitted and admits only after the canonical check settles", async () => {
  const admission = create();
  const resume = createDeferred();
  const check = vi.fn();
  expect(admission.canWrite).toBe(false);
  const pending = admission.revalidate(check, () => resume.promise);
  expect(admission.canWrite).toBe(false);
  resume.resolve();
  await pending;
  expect(check).toHaveBeenCalledTimes(2);
  expect(admission.canWrite).toBe(true);
  expect(admission.failure).toBeUndefined();
});

it.each(["concurrent", "pending assertion", "direct guard", "asynchronous check"])(
  "keeps the first refusal after %s even when an earlier check later succeeds",
  async (kind) => {
    const admission = create();
    await admission.revalidate(() => {});
    const resume = createDeferred();
    const failure = new Error("canonical owner refused");
    const pending = admission
      .revalidate(
        () => {},
        async () => {
          await resume.promise;
          if (kind === "asynchronous check") {
            throw failure;
          }
        },
      )
      .catch((error: unknown) => error);
    try {
      if (kind === "concurrent") {
        await expect(admission.revalidate(() => {})).rejects.toThrow();
      }
      if (kind === "pending assertion") {
        expect(admission.assertCurrent).toThrow();
      }
      if (kind === "direct guard") {
        admission.revoke(failure);
      }
    } finally {
      resume.resolve();
    }
    const first = await pending;
    expect(first).toBeInstanceOf(Error);
    expect(admission.failure).toBe(first);
    expect(admission.canWrite).toBe(false);
    expect(admission.assertCurrent).toThrow(first as Error);
    await expect(admission.revalidate(() => {})).rejects.toBe(first);
    expect(admission.revoke(new Error("later refusal"))).toBe(first);
  },
);

it("retains the exact error from a direct authority check", async () => {
  const admission = create();
  await admission.revalidate(() => {});
  assertUpdateWriteAuthority(admission, () => {});
  const refusal = new Error("executor or requester changed");
  expect(() =>
    assertUpdateWriteAuthority(admission, () => {
      throw refusal;
    }),
  ).toThrow(refusal);
  expect(admission.failure).toBe(refusal);
  expect(admission.canWrite).toBe(false);
});

it.each(["direct", "revalidation", "command authority"])(
  "keeps diagnostic admission after the exact operation timeout through %s",
  async (owner) => {
    const admission = create();
    await admission.revalidate(() => {});
    const timeout = new UpdateActivationTimeoutError("/installation", 1000);
    const check = () => {
      throw timeout;
    };
    if (owner === "revalidation") {
      await expect(admission.revalidate(check)).rejects.toBe(timeout);
    } else if (owner === "command authority") {
      const refused = vi.fn();
      const authority = createUpdateCommandAuthority({
        opts: {
          run: {
            runId: "timeout-probe",
            env: {},
            executorFence: { assertCurrent: check },
            freebsdWriteAdmission: admission,
          },
        },
        onAuthorityRefused: refused,
      });
      expect(authority.assertCurrent).toThrow(timeout);
      expect(refused).not.toHaveBeenCalled();
      expect(authority.assertRequesterCurrent).not.toThrow();
    } else {
      expect(() => assertUpdateWriteAuthority(admission, check)).toThrow(timeout);
    }
    expect(admission.canWrite).toBe(true);
    expect(admission.failure).toBeUndefined();
    const nativeFailure = new Error("native generation replaced");
    expect(admission.revoke(nativeFailure)).toBe(nativeFailure);
    expect(admission.revoke(timeout)).toBe(nativeFailure);
    expect(admission.canWrite).toBe(false);
  },
);

it("does not exempt an aggregate containing a timeout and a custody failure", async () => {
  const admission = create();
  await admission.revalidate(() => {});
  const failure = new AggregateError([
    new UpdateActivationTimeoutError("/installation", 1000),
    new Error("child release refused"),
  ]);
  expect(admission.revoke(failure)).toBe(failure);
  expect(admission.canWrite).toBe(false);
});
