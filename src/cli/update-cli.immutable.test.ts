import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UpdateImmutableInstall } from "../../packages/gateway-protocol/src/schema/config.js";
import * as immutable from "../infra/update-immutable-install.js";
import * as retainedRuntime from "../infra/update-retained-runtime.js";
import * as recoveryAdmission from "../infra/update-run-recovery-admission.js";
import { defaultRuntime, ExitError } from "../runtime.js";
import * as stateOwnership from "../state/openclaw-state-ownership-preflight.js";
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

function mockPreparation(
  overrides: Partial<Awaited<ReturnType<typeof immutable.prepareImmutableUpdate>>> = {},
) {
  return vi.spyOn(immutable, "prepareImmutableUpdate").mockResolvedValue({
    status: "prepared",
    installation: { ...installation, prepared: preparedReceipt },
    targetSha,
    steps: [],
    warnings: [],
    ...overrides,
  });
}

function expectJson(fields: Record<string, unknown>) {
  expect(defaultRuntime.writeJson).toHaveBeenCalledWith(expect.objectContaining(fields));
}

beforeEach(() => {
  for (const action of Object.values(activation)) {
    action
      .mockReset()
      .mockResolvedValue({ status: "succeeded", installation: committedInstallation });
  }
  vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(installation.currentPath);
  vi.spyOn(immutable, "inspectImmutableInstall").mockResolvedValue(installation);
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  vi.spyOn(retainedRuntime, "withRetainedUpdateRuntime").mockImplementation(() => {
    throw new Error("Immutable preparation must not enter mutable runtime retention");
  });
});
afterEach(() => vi.restoreAllMocks());

it("dispatches immutable preparation before mutable admission", async () => {
  const prepare = mockPreparation();
  await updateCommand({ json: true, dryRun: false, sha: targetSha, timeout: "60" });
  expect(prepare).toHaveBeenCalledWith(
    expect.objectContaining({ sha: targetSha, timeoutMs: 60_000 }),
  );
  expectJson({ status: "prepared", installKind: "immutable", activation: "disabled", targetSha });
  expect(retainedRuntime.withRetainedUpdateRuntime).not.toHaveBeenCalled();
  expect(activation.activate).not.toHaveBeenCalled();
});

it.each([
  [false, "candidate-build-failed", { activation: "disabled" }],
  [
    true,
    "immutable-activation-failed",
    { message: expect.stringContaining("returned no generation receipt") },
  ],
] as const)(
  "reports failed preparation/receipt without mutable fallback (enabled=%s)",
  async (enabled, reason, details) => {
    const adopted = enabled ? { ...installation, activationEnabled: true } : installation;
    vi.mocked(immutable.inspectImmutableInstall).mockResolvedValue(adopted);
    mockPreparation({
      installation: adopted,
      ...(enabled ? {} : { status: "error", reason }),
    });
    await expect(updateCommand({ json: true })).rejects.toMatchObject({ code: 1 });
    expectJson({ status: "error", reason, ...details });
    expect(activation.activate).not.toHaveBeenCalled();
    expect(retainedRuntime.withRetainedUpdateRuntime).not.toHaveBeenCalled();
  },
);

it.each([false, true])("retains build warnings when activation throws (JSON: %s)", async (json) => {
  const warning = "Built without the isolated build account";
  vi.spyOn(immutable, "inspectImmutableInstall").mockResolvedValue({
    ...installation,
    activationEnabled: true,
  });
  const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  vi.spyOn(immutable, "prepareImmutableUpdate").mockImplementation(async ({ onWarning }) => {
    onWarning?.(warning);
    expect(error).toHaveBeenCalledExactlyOnceWith(`Warning: ${warning}`);
    expect(activation.activate).not.toHaveBeenCalled();
    return {
      status: "prepared",
      installation: { ...installation, prepared: preparedReceipt },
      targetSha,
      steps: [],
      warnings: [warning],
    };
  });
  activation.activate.mockRejectedValueOnce(new Error("Activation failed"));
  await expect(updateCommand({ json })).rejects.toBeInstanceOf(ExitError);
  if (json) {
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({ warnings: [warning] }),
    );
    expect(error).toHaveBeenCalledExactlyOnceWith(`Warning: ${warning}`);
  } else {
    expect(error.mock.calls.filter(([message]) => message === `Warning: ${warning}`)).toHaveLength(
      1,
    );
  }
});

it.each([
  ["unsupported channel", { channel: "beta" }, { reason: "immutable-preparation-refused" }],
  ["ownership inspection", {}, { message: "Unadopted release layout" }],
  [
    "invalid drain budget",
    { drainTimeout: "invalid" },
    { message: "--drain-timeout must be a positive integer (seconds)" },
  ],
] as const)(
  "refuses %s before candidate work or mutable admission",
  async (name, options, fields) => {
    if (name === "ownership inspection") {
      vi.mocked(immutable.inspectImmutableInstall).mockRejectedValue(
        new Error("Unadopted release layout"),
      );
    }
    const prepare = vi.spyOn(immutable, "prepareImmutableUpdate");
    const command = updateCommand({ json: true, ...options });
    await expect(command).rejects.toMatchObject({ code: 1 });
    expectJson({ status: "error", ...fields });
    expect(prepare).not.toHaveBeenCalled();
    expect(activation.activate).not.toHaveBeenCalled();
    expect(retainedRuntime.withRetainedUpdateRuntime).not.toHaveBeenCalled();
  },
);

it.each([
  ["repair", updateRepairCommand],
  ["finalize", updateFinalizeCommand],
] as const)("refuses immutable %s before admitting writable state", async (_name, command) => {
  vi.spyOn(recoveryAdmission, "assertUpdateRecoveryAdmission").mockResolvedValue(undefined);
  const admitState = vi
    .spyOn(stateOwnership, "assertOpenClawStateWriteAllowedAtPath")
    .mockRejectedValue(new Error("unexpected mutable state admission"));

  await expect(command({ json: true })).rejects.toBeInstanceOf(ExitError);

  expectJson({ status: "error", reason: "immutable-repair-unsupported" });
  expect(admitState).not.toHaveBeenCalled();
});

it.each([
  [true, false, true],
  [false, false, false],
  [true, true, false],
])("activation policy restart=%s dryRun=%s activates=%s", async (restart, dryRun, activates) => {
  const adopted = { ...installation, activationEnabled: true };
  vi.mocked(immutable.inspectImmutableInstall).mockResolvedValue(adopted);
  mockPreparation({
    status: dryRun ? "dry-run" : "prepared",
    installation: dryRun ? adopted : { ...adopted, prepared: preparedReceipt },
  });
  await updateCommand({ json: true, restart, dryRun, timeout: " 600 ", drainTimeout: "30" });
  expect(activation.activate).toHaveBeenCalledTimes(activates ? 1 : 0);
  if (activates) {
    expect(activation.activate).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedPrepared: preparedReceipt,
        timeoutMs: 600_000,
        drainTimeoutMs: 30_000,
      }),
    );
    expectJson({ installation: committedInstallation });
  }
  expectJson({ status: activates ? "succeeded" : dryRun ? "dry-run" : "prepared" });
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
      expectJson({ status: "pending", phase: "verifying", recoveryCommand });
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
