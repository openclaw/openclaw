import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as terminal from "../../packages/terminal-core/src/note.js";
import { loadExecApprovalsReadOnly } from "../infra/exec-approvals-store.js";
import { saveExecApprovals, testing } from "../infra/exec-approvals-store.test-support.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  createDoctorPrompterFixture,
  decideDoctorContributionPending,
} from "./doctor-health-context.test-support.js";
import * as core from "./doctor-health-contribution-core.js";
import {
  createDoctorHealthFlowContext,
  resolveDoctorHealthContributions,
} from "./doctor-health-contributions.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  closeOpenClawStateDatabaseForTest();
  testing.reset();
});

const legacyState = () =>
  resolveDoctorHealthContributions().find((entry) => entry.id === "doctor:legacy-state")!;

// mock-isolation: Supply only the rescan's reporting fields; no migration writer runs.
vi.mock("../infra/state-migrations.doctor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/state-migrations.doctor.js")>()),
  detectLegacyStateMigrations: vi.fn(async () => ({
    preview: [],
    warnings: ["prior warning", "new warning"],
    notices: ["prior notice", "new notice"],
  })),
}));

it("reports only new detection notices when legacy state needs another scan", async () => {
  const note = vi.spyOn(terminal, "note").mockImplementation(() => {});
  vi.spyOn(core, "runCoreContributionHealth").mockResolvedValue(undefined);
  const ctx = createDoctorHealthFlowContext({
    configResult: {
      stateMigrationStepReceipts: [
        {
          id: "migration-detection",
          phase: "shared",
          source: [],
          target: [],
          requiredness: "required",
          reversibility: "not-applicable",
          outcome: "skipped",
          changes: [],
          warnings: ["prior warning"],
          notices: ["prior notice"],
        },
      ],
    },
  });

  await legacyState().run(ctx);

  expect(note).toHaveBeenCalledWith("new warning", "Doctor warnings");
  expect(note).toHaveBeenCalledWith("new notice", "Doctor notices");
  expect(note).not.toHaveBeenCalledWith(expect.stringContaining("prior"), expect.anything());
});

it("has pending work while preflight left state to migrate or the store holds obsolete grants", async () => {
  await withTestDir({ prefix: "openclaw-legacy-state-pending-" }, async (home) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(home, ".openclaw"));
    vi.spyOn(terminal, "note").mockImplementation(() => {});
    const cfg = {};
    const ctx = createDoctorHealthFlowContext({
      cfg,
      options: { repair: true, nonInteractive: true },
      prompter: createDoctorPrompterFixture(true),
      configResult: { cfg, preflightLegacyStateConfig: cfg },
    });
    saveExecApprovals({
      version: 1,
      agents: { main: { allowlist: [{ pattern: "/usr/bin/manual" }] } },
    });
    await expect(decideDoctorContributionPending(legacyState(), ctx)).resolves.toBe("none");
    const unmigrated = {
      ...ctx,
      configResult: { ...ctx.configResult, preflightLegacyStateConfig: undefined },
    };
    await expect(decideDoctorContributionPending(legacyState(), unmigrated)).resolves.toBe("work");

    saveExecApprovals({
      version: 1,
      agents: { main: { allowlist: [{ pattern: "/usr/bin/git", source: "allow-always" }] } },
    });
    await expect(decideDoctorContributionPending(legacyState(), ctx)).resolves.toBe("work");
    await legacyState().run(ctx);
    expect(loadExecApprovalsReadOnly().agents?.main?.allowlist).toEqual([]);
    await expect(decideDoctorContributionPending(legacyState(), ctx)).resolves.toBe("none");
  });
});
