import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UpdateImmutableInstall } from "../../packages/gateway-protocol/src/schema/config.js";
import * as immutable from "../infra/update-immutable-install.js";
import * as retainedRuntime from "../infra/update-retained-runtime.js";
import * as recoveryAdmission from "../infra/update-run-recovery-admission.js";
import { defaultRuntime, ExitError } from "../runtime.js";
import * as stateOwnership from "../state/openclaw-state-ownership.js";
import * as shared from "./update-cli/shared.js";
import { updateFinalizeCommand } from "./update-cli/update-command-finalize.js";
import { updateCommand } from "./update-cli/update-command.js";
import { updateRepairCommand } from "./update-cli/update-repair-command.js";

const installation: UpdateImmutableInstall = {
  root: "/opt/example",
  currentSha: "a".repeat(40),
  currentPath: `/opt/example/releases/${"a".repeat(40)}`,
};
const targetSha = "b".repeat(40);

beforeEach(() => {
  vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(installation.currentPath);
  vi.spyOn(immutable, "inspectImmutableInstall").mockResolvedValue(installation);
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  vi.spyOn(retainedRuntime, "withRetainedUpdateRuntime").mockImplementation(() => {
    throw new Error("Immutable preparation must not enter mutable runtime retention");
  });
});
afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "dispatches immutable preparation before mutable admission (dry-run=%s)",
  async (dryRun) => {
    const prepared = vi.spyOn(immutable, "prepareImmutableUpdate").mockResolvedValue({
      status: dryRun ? "dry-run" : "prepared",
      installation,
      targetSha,
      steps: [],
      warnings: [],
    });

    await updateCommand({ json: true, dryRun, sha: targetSha, timeout: "60" });

    expect(prepared).toHaveBeenCalledWith({
      root: installation.currentPath,
      sha: targetSha,
      dryRun,
      timeoutMs: 60_000,
    });
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        status: dryRun ? "dry-run" : "prepared",
        installKind: "immutable",
        activation: "unavailable",
        targetSha,
      }),
    );
    expect(retainedRuntime.withRetainedUpdateRuntime).not.toHaveBeenCalled();
  },
);

it("reports preparation failure without entering the mutable update lifecycle", async () => {
  vi.spyOn(immutable, "prepareImmutableUpdate").mockResolvedValue({
    status: "error",
    reason: "candidate-build-failed",
    installation,
    targetSha,
    steps: [],
    warnings: [],
  });

  await expect(updateCommand({ json: true })).rejects.toMatchObject({ code: 1 });

  expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
    expect.objectContaining({
      status: "error",
      reason: "candidate-build-failed",
      activation: "unavailable",
    }),
  );
  expect(retainedRuntime.withRetainedUpdateRuntime).not.toHaveBeenCalled();
});

it("refuses unsupported immutable channel changes before candidate work", async () => {
  const prepare = vi.spyOn(immutable, "prepareImmutableUpdate");

  await expect(updateCommand({ json: true, channel: "beta" })).rejects.toBeInstanceOf(ExitError);

  expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
    expect.objectContaining({ status: "error", reason: "immutable-preparation-refused" }),
  );
  expect(prepare).not.toHaveBeenCalled();
  expect(retainedRuntime.withRetainedUpdateRuntime).not.toHaveBeenCalled();
});

it("does not fall back to mutable Git when immutable ownership inspection refuses", async () => {
  vi.mocked(immutable.inspectImmutableInstall).mockRejectedValue(
    new Error("Unadopted release layout"),
  );
  const prepare = vi.spyOn(immutable, "prepareImmutableUpdate");

  await expect(updateCommand({ json: true })).rejects.toBeInstanceOf(ExitError);

  expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
    expect.objectContaining({ status: "error", message: "Unadopted release layout" }),
  );
  expect(prepare).not.toHaveBeenCalled();
  expect(retainedRuntime.withRetainedUpdateRuntime).not.toHaveBeenCalled();
});

it.each([
  ["repair", updateRepairCommand],
  ["finalize", updateFinalizeCommand],
] as const)("refuses immutable %s before admitting writable state", async (_name, command) => {
  vi.spyOn(recoveryAdmission, "assertUpdateRecoveryAdmission").mockResolvedValue(undefined);
  const admitState = vi
    .spyOn(stateOwnership, "assertOpenClawStateWriteAllowedAtPath")
    .mockRejectedValue(new Error("unexpected mutable state admission"));

  await expect(command({ json: true })).rejects.toBeInstanceOf(ExitError);

  expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
    expect.objectContaining({
      status: "error",
      reason: "immutable-activation-unavailable",
      activation: "unavailable",
    }),
  );
  expect(admitState).not.toHaveBeenCalled();
});
