import { beforeEach, expect, it, vi } from "vitest";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { resumeRecipeTargetService } from "./recipe-resume-target.js";
import { approvedContext } from "./update-recipe-context.test-support.js";

const mocks = vi.hoisted(() => ({
  intent: vi.fn(),
  observe: vi.fn(),
  prepare: vi.fn(),
  restart: vi.fn(),
  verify: vi.fn(),
  reconcile: vi.fn(),
}));
vi.mock("../../infra/upgrade-recipes/receipts-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/upgrade-recipes/receipts-worker.js")>()),
  createFencedUpgradeRecipeStepReceiptRecorder: () => ({ read: mocks.intent }),
}));
vi.mock("./recipe-step-execution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./recipe-step-execution.js")>()),
  resolveRecipeStepBinding: async () => ({}),
  observeRecipeServiceForRecovery: mocks.observe,
  prepareRecipeServiceActivation: mocks.prepare,
  reconcileRecipeServiceActivation: mocks.reconcile,
  reconcileRecipePackagePublication: vi.fn(),
  reconcileRecipeTargetMaintenance: vi.fn(),
}));
vi.mock("./update-command-service-command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-command.js")>()),
  runUpdatedInstallGatewayCommand: mocks.restart,
}));
vi.mock("./update-command-verification.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-verification.js")>()),
  verifyUpdatedGateway: mocks.verify,
}));
const recipe = approvedContext();
const env = { OPENCLAW_STATE_DIR: recipe.maintenance.expected.stateRoot };
const owner = { env, assertCurrent: vi.fn(), assertEffectsSettled: vi.fn() };
const result: UpdateRunResult = { status: "ok", mode: "npm", steps: [], durationMs: 0 };
const input = { recipe, owner, opts: { json: true }, result };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.intent.mockResolvedValue({ phase: "intent" });
  mocks.observe.mockResolvedValue({
    state: { env, running: true, runtime: { status: "running", pid: 42 } },
    verdict: { kind: "owned", fingerprint: recipe.service.beforeDefinitionFingerprint },
  });
  mocks.restart.mockResolvedValue("accepted");
  mocks.verify.mockImplementation(async (params: { onVerified: () => void }) => {
    params.onVerified();
    return { ok: true };
  });
});
it("reconciles lost activation reply with fresh readiness, never restarting a running target", async () => {
  await resumeRecipeTargetService(input);
  expect(mocks.restart).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.verify).toHaveBeenCalledWith(
    expect.objectContaining({
      expectedVersion: recipe.maintenance.expected.version,
      expectedBuildId: recipe.maintenance.expected.buildId,
      requireRunningService: true,
    }),
  );
  expect(mocks.reconcile).toHaveBeenCalledWith(recipe, owner, true);
});
it("refuses adoption of a running service whose original activation intent is absent", async () => {
  mocks.intent.mockResolvedValue(null);
  await expect(resumeRecipeTargetService(input)).rejects.toThrow("no original activation intent");
  expect(mocks.restart).not.toHaveBeenCalled();
  expect(mocks.verify).not.toHaveBeenCalled();
});
it("restarts only the approved owned stopped definition, preserving an existing intent", async () => {
  mocks.observe.mockResolvedValue({
    state: { env, running: false, runtime: { status: "stopped" } },
    verdict: { kind: "owned", fingerprint: recipe.service.beforeDefinitionFingerprint },
  });
  await resumeRecipeTargetService(input);
  expect(mocks.restart).toHaveBeenCalledTimes(1);
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.reconcile).toHaveBeenCalledWith(recipe, owner, true);
});
it("does not replay a previously verified activation after the service later stops", async () => {
  mocks.intent.mockResolvedValue({ phase: "verified" });
  mocks.observe.mockResolvedValue({
    state: { env, running: false, runtime: { status: "stopped" } },
    verdict: { kind: "owned", fingerprint: recipe.service.beforeDefinitionFingerprint },
  });
  await expect(resumeRecipeTargetService(input)).rejects.toThrow("historical activation");
  expect(mocks.restart).not.toHaveBeenCalled();
});
it("rejects unknown native state and failed fresh readiness without recording completion", async () => {
  mocks.observe.mockResolvedValue({ state: { env, runtime: { status: "unknown" } }, verdict: {} });
  await expect(resumeRecipeTargetService(input)).rejects.toThrow("state is unknown");
  expect(mocks.restart).not.toHaveBeenCalled();
  mocks.observe.mockResolvedValue({
    state: { env, running: true, runtime: { status: "running" } },
    verdict: {},
  });
  mocks.verify.mockResolvedValue({ ok: false });
  await expect(resumeRecipeTargetService(input)).rejects.toThrow("readiness is unverified");
  expect(mocks.reconcile).not.toHaveBeenCalled();
});
it("leaves stopped service unchanged when its native definition drifts after approval", async () => {
  mocks.observe.mockRejectedValue(
    new Error("Native service definition differs from explicit approval"),
  );
  await expect(resumeRecipeTargetService(input)).rejects.toThrow("differs from explicit approval");
  expect(mocks.restart).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
});
