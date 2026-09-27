import { afterEach, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { recordDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import {
  createUpdateRun,
  finishUpdateRun,
  recordUpdateRunStep,
} from "../infra/update-run-ledger.js";
import { getUpdateRun, listUpdateRunsAsync } from "../infra/update-run-reader.js";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { noteStaleUpdateRuns } from "./doctor-update-run.js";

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));
vi.mock("../infra/update-run-reader.js", async (original) => ({
  ...(await original<typeof import("../infra/update-run-reader.js")>()),
  listUpdateRunsAsync: vi.fn(),
}));
vi.mock("../infra/update-run-interruption.js", async (original) => ({
  ...(await original<typeof import("../infra/update-run-interruption.js")>()),
  reconcileInterruptedUpdateRuns: async () => [],
}));

afterEach(() => vi.resetAllMocks());

it.each([
  {
    reason: "node-runtime-preflight",
    nextAction: [
      "openclaw@2026.9.4 requires Node >=24.16.0; selected runtime is Node 22.23.2.",
      "Recovery:",
      "1. Use the same service account and keep the existing OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH overrides throughout recovery.",
      "2. Run `nvm install 24.16.0 && nvm use 24.16.0`.",
      "3. Run `node /original/openclaw/openclaw.mjs update --tag 2026.9.4`.",
    ].join("\n"),
  },
  {
    reason: "global-install-foreign-destination",
    nextAction:
      "Selected npm destination /other-prefix is occupied by another OpenClaw installation: launcher /other-prefix/bin/openclaw. No selected managed service claims this destination. Switch the runtime back and run `node /original/openclaw/openclaw.mjs update`.",
  },
  { reason: "global-install-foreign-destination", nextAction: undefined },
  {
    reason: "global-install-permission-denied",
    nextAction:
      "Cannot write /opt/openclaw-prefix/lib/node_modules (owned by root); run the package update as the directory's owning account. Pull or build an OpenClaw image with the target version, then recreate or redeploy the container with the same state/config mounts.",
  },
])("keeps $reason remediation visible until a later successful update", async (failure) => {
  let latest: UpdateRunRecord = {
    runId: "6631ecee-adbf-41e8-a0e3-1b88b28b0a59",
    createdAtMs: 1,
    updatedAtMs: 2,
    trigger: "cli",
    phase: "finished",
    status: "failed",
    reason: failure.reason,
    origin: { nextAction: failure.nextAction },
    target: { kind: "package", version: "2026.9.4" },
    before: { version: "2026.7.1-2" },
    after: {},
    steps: [{ step: failure.reason, status: "failed", detail: failure.nextAction }],
    verification: {},
    repair: [],
    confirmedAtMs: null,
    finishedAtMs: 2,
    downtimeMs: null,
  };
  vi.mocked(listUpdateRunsAsync).mockImplementation(async (input) =>
    input?.active ? [] : [latest],
  );

  await noteStaleUpdateRuns({});

  expect(note).toHaveBeenCalledOnce();
  expect(note).toHaveBeenCalledWith(
    expect.stringContaining(`OpenClaw update failed: ${failure.reason}`),
    "Update history",
  );
  expect(note).toHaveBeenCalledWith(
    expect.stringContaining(
      failure.nextAction ??
        "https://docs.openclaw.ai/install/update-troubleshooting#node-and-global-install-permissions",
    ),
    "Update history",
  );

  latest = {
    ...latest,
    runId: "e8a1ac89-4a31-41f6-b401-4b225b661728",
    createdAtMs: 3,
    updatedAtMs: 4,
    finishedAtMs: 4,
    status: "succeeded",
    reason: null,
    origin: {},
    after: { version: "2026.9.4" },
    steps: [],
  };
  vi.mocked(note).mockClear();

  await noteStaleUpdateRuns({});

  expect(note).not.toHaveBeenCalled();
});

it.each(["state migration is pending", "data/settings upgrade is unfinished"])(
  "stops replaying resolved %s warnings without erasing history",
  async (wording) => {
    await withOpenClawTestState({ label: "update-warning-resolution" }, async () => {
      const pending = (pluginId: string) => ({
        pluginId,
        reason: "The plugin has not reported completion.",
        command: "openclaw doctor --fix",
      });
      await recordDeferredPluginMigrations({
        pending: [pending("resolved"), pending("unfinished")],
      });
      const warnings = [
        `Plugin "unrecorded" ${wording}: Completion has never been recorded.`,
        `Plugin "unfinished" ${wording}: The plugin has not reported completion.`,
        "Unrelated update warning",
        `Plugin "resolved" ${wording}: The plugin has not reported completion.`,
      ];
      const run = createUpdateRun({ trigger: "cli" });
      for (const [index, detail] of warnings.entries()) {
        recordUpdateRunStep(run.runId, {
          step: `warning:openclaw doctor:${index}`,
          status: "completed",
          detail,
          endedAtMs: 1,
        });
      }
      const history = finishUpdateRun(run.runId, { status: "succeeded" });
      let latestRunId = run.runId;
      vi.mocked(listUpdateRunsAsync).mockImplementation(async (input) =>
        input?.active ? [] : [getUpdateRun(latestRunId)!],
      );
      const output = async () => {
        vi.mocked(note).mockClear();
        await noteStaleUpdateRuns({ migrateState: false });
        return vi
          .mocked(note)
          .mock.calls.map(([message]) => message)
          .join("\n");
      };
      expect(await output()).toContain(warnings[3]);

      await recordDeferredPluginMigrations({ pending: [], resolvedPluginIds: ["resolved"] });
      const repaired = await output();
      expect(repaired).not.toContain(warnings[3]);
      for (const warning of warnings.slice(0, 3)) {
        expect(repaired).toContain(warning);
      }
      expect(getUpdateRun(run.runId)).toEqual(history);

      await recordDeferredPluginMigrations({ pending: [pending("resolved")] });
      expect(await output()).toContain(warnings[3]);
      expect(getUpdateRun(run.runId)).toEqual(history);

      await recordDeferredPluginMigrations({ pending: [], resolvedPluginIds: ["resolved"] });
      const later = createUpdateRun({ trigger: "cli" });
      recordUpdateRunStep(later.runId, {
        step: "warning:openclaw doctor",
        status: "completed",
        detail: warnings[3],
        endedAtMs: Date.now() + 60_000,
      });
      const laterHistory = finishUpdateRun(later.runId, { status: "succeeded" });
      latestRunId = later.runId;
      expect(await output()).toContain(warnings[3]);
      expect(getUpdateRun(later.runId)).toEqual(laterHistory);
    });
  },
);
