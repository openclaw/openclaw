import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  resolveCommandProcessSignal,
  retainCommandProcessCleanup,
} from "../../process/exec-spawn.js";
import { defaultRuntime } from "../../runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { waitForSignalExitBarriers } from "../signal-exit-barrier.js";
import { tryRunImmutableUpdateCommand } from "./update-command-immutable.js";

const mocks = vi.hoisted(() => ({
  inspect:
    vi.fn<typeof import("../../infra/update-immutable-install.js").inspectImmutableInstall>(),
  prepare: vi.fn<typeof import("../../infra/update-immutable-install.js").prepareImmutableUpdate>(),
  activate:
    vi.fn<typeof import("../../infra/update-immutable-activation.js").activateImmutableUpdate>(),
}));
// mock-isolation: Keep privileged installation I/O fixed while the real command scope and exit gate run.
vi.mock("../../infra/update-immutable-install.js", () => ({
  adoptImmutableInstall: vi.fn(),
  inspectImmutableInstall: mocks.inspect,
  prepareImmutableUpdate: mocks.prepare,
}));
// mock-isolation: Isolate real service activation; this fixture observes whether activation is attempted.
vi.mock("../../infra/update-immutable-activation.js", () => ({
  activateImmutableUpdate: mocks.activate,
}));
vi.mock("./shared.js", async (original) => ({
  ...(await original<typeof import("./shared.js")>()),
  resolveUpdateRoot: async () => "/immutable-fixture",
}));
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "joins preparation cleanup before activation (interrupted=%s)",
  async (interrupted) => {
    const installation = {
      root: "/immutable-fixture",
      currentSha: "a".repeat(40),
      currentPath: "/immutable-fixture/releases/current",
      activationEnabled: true,
      prepared: {
        sha: "b".repeat(40),
        path: "/immutable-fixture/releases/prepared",
        buildDigest: "c".repeat(64),
        preparedAtMs: 1,
      },
    };
    const cleanup = createDeferredCore();
    const joining = createDeferredCore();
    let cleanupFinished = false;
    mocks.inspect.mockResolvedValue(installation);
    mocks.activate.mockResolvedValue({ status: "succeeded", installation });
    mocks.prepare.mockImplementation(async () => {
      // Scope settlement aborts after preparation returns, then joins this cleanup.
      resolveCommandProcessSignal()!.addEventListener("abort", () => joining.resolve(), {
        once: true,
      });
      retainCommandProcessCleanup(
        cleanup.promise.then(() => {
          cleanupFinished = true;
        }),
      );
      return { status: "prepared", installation, steps: [], warnings: [] };
    });
    const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    const operation = tryRunImmutableUpdateCommand({ json: true });
    await joining.promise;
    const drain = interrupted ? waitForSignalExitBarriers() : Promise.resolve();
    const activationBeforeCleanup = mocks.activate.mock.calls.length;
    cleanup.resolve();
    const outcome = await operation.then(
      () => undefined,
      (error: unknown) => error,
    );
    await drain;
    expect(cleanupFinished).toBe(true);
    expect(activationBeforeCleanup).toBe(0);
    expect(mocks.activate).toHaveBeenCalledTimes(interrupted ? 0 : 1);
    if (interrupted) {
      expect(outcome).toMatchObject({ name: "ExitError", code: 1 });
      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "immutable-preparation-refused" }),
      );
    } else {
      expect(outcome).toBeUndefined();
      expect(output).toHaveBeenCalledWith(expect.objectContaining({ status: "succeeded" }));
    }
  },
);
