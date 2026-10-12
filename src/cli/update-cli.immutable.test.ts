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

const activation = vi.hoisted(() => ({
  activate:
    vi.fn<typeof import("../infra/update-immutable-activation.js").activateImmutableUpdate>(),
  recover: vi.fn<typeof import("../infra/update-immutable-activation.js").recoverImmutableUpdate>(),
}));
vi.mock("../infra/update-immutable-activation.js", () => ({
  activateImmutableUpdate: activation.activate,
  recoverImmutableUpdate: activation.recover,
}));

const installation: UpdateImmutableInstall = {
  root: "/opt/example",
  currentSha: "a".repeat(40),
  currentPath: `/opt/example/releases/${"a".repeat(40)}`,
};
const targetSha = "b".repeat(40);
const preparedReceipt: NonNullable<UpdateImmutableInstall["prepared"]> = {
  sha: targetSha,
  path: `/opt/example/releases/${targetSha}`,
  buildDigest: "c".repeat(64),
  preparedAtMs: 123,
};
const committedInstallation: UpdateImmutableInstall = {
  ...installation,
  currentSha: targetSha,
  currentPath: preparedReceipt.path,
  activationEnabled: true,
};

beforeEach(() => {
  activation.activate
    .mockReset()
    .mockResolvedValue({ status: "succeeded", installation: committedInstallation });
  activation.recover
    .mockReset()
    .mockResolvedValue({ status: "succeeded", installation: committedInstallation });
  vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(installation.currentPath);
  vi.spyOn(immutable, "inspectImmutableInstall").mockResolvedValue(installation);
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  vi.spyOn(retainedRuntime, "withRetainedUpdateRuntime").mockImplementation(() => {
    throw new Error("Immutable preparation must not enter mutable runtime retention");
  });
});
afterEach(() => vi.restoreAllMocks());

it.each([false])(
  "dispatches immutable preparation before mutable admission (dry-run=%s)",
  async (dryRun) => {
    const prepared = vi.spyOn(immutable, "prepareImmutableUpdate").mockResolvedValue({
      status: dryRun ? "dry-run" : "prepared",
      installation: dryRun ? installation : { ...installation, prepared: preparedReceipt },
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
        activation: "disabled",
        targetSha,
      }),
    );
    expect(retainedRuntime.withRetainedUpdateRuntime).not.toHaveBeenCalled();
    expect(activation.activate).not.toHaveBeenCalled();
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
      activation: "disabled",
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
      reason: "immutable-repair-unsupported",
    }),
  );
  expect(admitState).not.toHaveBeenCalled();
});

it.each([
  { enabled: true, restart: true, dryRun: false, activates: true },
  { enabled: true, restart: false, dryRun: false, activates: false },
  { enabled: true, restart: true, dryRun: true, activates: false },
])("activates only under enabled adoption and restart policy: %j", async (entry) => {
  const adopted = { ...installation, activationEnabled: entry.enabled };
  vi.mocked(immutable.inspectImmutableInstall).mockResolvedValue(adopted);
  vi.spyOn(immutable, "prepareImmutableUpdate").mockResolvedValue({
    status: entry.dryRun ? "dry-run" : "prepared",
    installation: entry.dryRun ? adopted : { ...adopted, prepared: preparedReceipt },
    targetSha,
    steps: [],
    warnings: [],
  });
  await updateCommand({
    json: true,
    restart: entry.restart,
    dryRun: entry.dryRun,
    timeout: "600",
    drainTimeout: "30",
  });
  expect(activation.activate).toHaveBeenCalledTimes(entry.activates ? 1 : 0);
  if (entry.activates) {
    expect(activation.activate).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedPrepared: preparedReceipt,
        timeoutMs: 600_000,
        drainTimeoutMs: 30_000,
      }),
    );
    const output = vi.mocked(defaultRuntime.writeJson).mock.calls.at(-1)?.[0];
    expect(output).toHaveProperty("installation", committedInstallation);
    expect(output).not.toHaveProperty("installation.prepared");
  }
  expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
    expect.objectContaining({
      status: entry.activates ? "succeeded" : entry.dryRun ? "dry-run" : "prepared",
    }),
  );
  expect(retainedRuntime.withRetainedUpdateRuntime).not.toHaveBeenCalled();
});

it.each([false, true])(
  "keeps pending recovery and its independent command visible (json=%s)",
  async (json) => {
    const { updateRecoverImmutableCommand } =
      await import("./update-cli/update-command-immutable.js");
    const recoveryCommand = "/usr/bin/node /opt/example.control/recovery.mjs";
    activation.recover.mockResolvedValue({
      status: "pending",
      phase: "verifying",
      recoveryCommand,
      installation,
    });
    await expect(
      updateRecoverImmutableCommand({
        root: installation.root,
        json,
        timeout: "600",
        drainTimeout: "30",
      }),
    ).rejects.toMatchObject({ code: 1 });
    expect(activation.recover).toHaveBeenCalledWith(
      expect.objectContaining({
        root: installation.root,
        timeoutMs: 600_000,
        drainTimeoutMs: 30_000,
      }),
    );
    if (json) {
      expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({ status: "pending", phase: "verifying", recoveryCommand }),
      );
    } else {
      expect(defaultRuntime.log).toHaveBeenCalledWith(`Recovery: ${recoveryCommand}`);
    }
    expect(activation.activate).not.toHaveBeenCalled();
    expect(retainedRuntime.withRetainedUpdateRuntime).not.toHaveBeenCalled();
  },
);

it("refuses a drain budget on a mutable installation before runtime retention", async () => {
  vi.mocked(immutable.inspectImmutableInstall).mockResolvedValue(null);
  await expect(updateCommand({ json: true, drainTimeout: "30" })).rejects.toThrow(
    "--drain-timeout requires an adopted immutable installation",
  );
  expect(retainedRuntime.withRetainedUpdateRuntime).not.toHaveBeenCalled();
});

it("refuses activation when preparation returns no generation receipt", async () => {
  const adopted = { ...installation, activationEnabled: true };
  vi.mocked(immutable.inspectImmutableInstall).mockResolvedValue(adopted);
  vi.spyOn(immutable, "prepareImmutableUpdate").mockResolvedValue({
    status: "prepared",
    installation: adopted,
    targetSha,
    steps: [],
    warnings: [],
  });

  await expect(updateCommand({ json: true })).rejects.toMatchObject({ code: 1 });

  expect(activation.activate).not.toHaveBeenCalled();
  expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
    expect.objectContaining({
      status: "error",
      reason: "immutable-activation-failed",
      message: expect.stringContaining("returned no generation receipt"),
    }),
  );
});

it("rejects an invalid drain budget before immutable preparation", async () => {
  const prepare = vi.spyOn(immutable, "prepareImmutableUpdate");
  await expect(updateCommand({ json: true, drainTimeout: "invalid" })).rejects.toMatchObject({
    code: 1,
  });
  expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
    expect.objectContaining({ message: "--drain-timeout must be a positive integer (seconds)" }),
  );
  expect(prepare).not.toHaveBeenCalled();
  expect(activation.activate).not.toHaveBeenCalled();
});
