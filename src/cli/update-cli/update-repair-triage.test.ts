import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openPackageActivationJournal } from "../../infra/package-update-activation-journal.js";
import { createPackageActivationLifetimeFixture } from "../../infra/package-update-activation-lifetime.test-support.js";
import { readPackageActivationReceipt } from "../../infra/package-update-activation.js";
import { inspectUpdateRecoveryBackups } from "../../infra/update-recovery-backup-status.js";
import {
  createUpdateRun,
  finishUpdateRun,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import { readUpdateRunStatus } from "../../infra/update-run-status.js";
import { validateTriageUpdateResolution } from "../../infra/update-triage-resolution.js";
import { defaultRuntime } from "../../runtime.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { assertUpdatePackageActivationAdmission } from "./update-command-package-activation.js";
import { updateRepairCommand } from "./update-repair-command.js";

const mocks = vi.hoisted(() => ({ root: vi.fn(), finalize: vi.fn() }));
vi.mock("./shared.js", async (original) => ({
  ...(await original<typeof import("./shared.js")>()),
  resolveUpdateRoot: mocks.root,
}));
// mock-isolation: Settlement is real; finalization must not run Doctor or touch a host service.
vi.mock("./update-command-finalize.js", () => ({ updateFinalizeCommand: mocks.finalize }));

const fixtures = createPackageActivationLifetimeFixture();
let state: OpenClawTestState;
beforeEach(async () => {
  vi.clearAllMocks();
  fixtures.setup();
  state = await createOpenClawTestState({
    label: "repair-triage",
    env: { OPENCLAW_UPDATE_RUN_ID: undefined },
  });
  await state.writeConfig({ plugins: { enabled: false } });
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
  mocks.finalize.mockImplementation(async () => {
    assertUpdatePackageActivationAdmission(await mocks.root());
  });
});
afterEach(async () => {
  await state.cleanup();
  await fixtures.lifetime.cleanup();
  vi.restoreAllMocks();
});

describe.skipIf(process.platform === "win32")(
  "triage after loss of package lease authority",
  () => {
    it.each(["missing", "replaced"] as const)(
      "requires explicit repair with a %s lease, empty recovery sets, and a successful last run",
      async (lease) => {
        const f = await fixtures.prepare();
        mocks.root.mockResolvedValue(f.packageRoot);
        const { databasePath } = openPackageActivationJournal(f.anchor).read().descriptor.authority;
        fs.renameSync(databasePath, `${databasePath}.before-reboot`);
        if (lease === "replaced") {
          fs.copyFileSync(`${databasePath}.before-reboot`, databasePath);
          fs.chmodSync(databasePath, 0o600);
        }
        const lastRun = createUpdateRun({
          trigger: "cli",
          target: { kind: "package", version: "1.0.0" },
        });
        recordUpdateRunStep(lastRun.runId, { step: "finalize:doctor", status: "completed" });
        finishUpdateRun(lastRun.runId, { status: "succeeded" });
        expect(await readUpdateRunStatus()).toMatchObject({ lastRun: { status: "succeeded" } });
        expect(await inspectUpdateRecoveryBackups()).toEqual([]);
        const error =
          lease === "missing" ? /ENOENT/ : /managed handoff lease database identity changed/;
        expect(() => readPackageActivationReceipt(f.packageRoot)).toThrow(error);
        expect(() => assertUpdatePackageActivationAdmission(f.packageRoot)).toThrow(
          expect.objectContaining({
            message: expect.stringMatching(error),
            result: expect.objectContaining({ reason: "update-recovery-pending", durationMs: 0 }),
          }),
        );
        const resolution = await validateTriageUpdateResolution({
          installRoot: f.packageRoot,
          env: process.env,
          signal: new AbortController().signal,
          validateDoctor: async () => ({ ok: true, score: 0, summary: "Doctor passed." }),
        });
        expect(resolution).toMatchObject({ ok: false, summary: expect.stringMatching(error) });
        expect(resolution.summary).toContain("`openclaw update repair`");
        expect(resolution.summary).not.toContain("retry `openclaw update`");

        await updateRepairCommand({ json: true, yes: true });

        expect(readPackageActivationReceipt(f.packageRoot)).toBeUndefined();
        expect(() => assertUpdatePackageActivationAdmission(f.packageRoot)).not.toThrow();
        expect(mocks.finalize).toHaveBeenCalledOnce();
        expect(defaultRuntime.error).toHaveBeenCalledWith(
          expect.stringContaining(
            lease === "missing" ? "recovery-lease-missing" : "recovery-lease-identity-changed",
          ),
        );
      },
    );
  },
);
