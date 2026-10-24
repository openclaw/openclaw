import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { execFileUtf8 } from "../../daemon/exec-file.js";
import * as locks from "../../daemon/service-operation-lock.js";
import * as authority from "../../daemon/service-update-authority.js";
import { createCommandResult } from "../../test-utils/npm-spec-install-test-helpers.js";

// Real scopes and read lifetime; inert external owners (not custody proof).
vi.mock("../../infra/file-lock.js", () => ({
  withFileLock: async (_file: string, _options: unknown, operation: () => Promise<unknown>) =>
    operation(),
}));
vi.mock("../../infra/update-managed-service-handoff-lease.js", () => ({
  createManagedHandoffLeaseStore: () => ({ assertSourceUnborrowed() {} }),
}));
vi.mock("../../infra/tmp-openclaw-dir.js", () => ({
  resolvePreferredOpenClawTmpDir: () => "/inert-native-placement",
}));
vi.mock("../../process/exec.js", () => ({
  runCommandWithTimeout: () => {
    throw new Error("Unexpected unbound native runner in inert composition check");
  },
}));
afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "joins current retained-read disposal inside native authority, disposal failure=%s",
  async (failClose) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const closing = createDeferred();
    const release = createDeferred();
    const original = new Error("current read operation failed");
    const cleanup = new Error("current binding disposal failed");
    const env = { HOME: "/inert-native-home", OPENCLAW_SYSTEMD_UNIT: "retained.service" };
    const binding = {
      unit: "retained.service",
      managerUid: 1000,
      destination: ":1.0",
      verify: vi.fn(() => authority.assertGatewayServiceUpdateCurrent()),
      query: vi.fn(async () => []),
      close: vi.fn(async () => {
        authority.assertGatewayServiceUpdateCurrent();
        closing.resolve();
        await release.promise;
        if (failClose) {
          throw cleanup;
        }
      }),
    };
    const create = vi.fn(async () => binding);
    const native = vi.fn(async () => createCommandResult({ stdout: "native output" }));
    const settle = vi.fn((value: string | undefined, error: unknown) => ({ value, error }));
    const result = authority
      .withGatewayServiceUpdateAuthority(
        () => undefined,
        () =>
          locks.withGatewayServiceOperationLock(env, async () => {
            await locks.withSystemdServiceReadBinding(env, create, async (selected) => {
              expect(selected).toBe(binding);
              expect(await execFileUtf8("inert", [], { env })).toMatchObject({
                stdout: "native output",
                code: 0,
              });
            });
            if (failClose) {
              throw original;
            }
            return "current scope completed";
          }),
        { nativeCommand: native },
      )
      .then(
        (value) => settle(value, undefined),
        (error: unknown) => settle(undefined, error),
      );
    await closing.promise;
    expect(settle).not.toHaveBeenCalled();
    expect([native, create, binding.verify].map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1]);
    release.resolve();
    const outcome = await result;
    if (failClose) {
      expect(outcome.error).toBeInstanceOf(AggregateError);
      expect(outcome.error).toMatchObject({ errors: [original, cleanup] });
    } else {
      expect(outcome).toEqual({ value: "current scope completed", error: undefined });
    }
    expect(binding.close).toHaveBeenCalledOnce();
    expect(binding.query).not.toHaveBeenCalled();
  },
);
