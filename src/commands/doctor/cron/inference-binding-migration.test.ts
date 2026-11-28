import fs from "node:fs/promises";
import { expect, it, vi } from "vitest";
import * as noteModule from "../../../../packages/terminal-core/src/note.js";
import { captureAuthProfileAuthorization } from "../../../agents/auth-profiles/authorization.js";
import { persistAuthProfileBatch } from "../../../agents/auth-profiles/upsert-with-lock.js";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { hashCronJobDefinition } from "../../../cron/definition-hash.js";
import { cronJobReadView } from "../../../cron/job-read-view.js";
import { resolveCronOperatorExecutionRevision } from "../../../cron/service/jobs-tool-policy.js";
import { applyJobPatch } from "../../../cron/service/jobs.js";
import { loadCronJobsStore, saveCronJobsStore } from "../../../cron/store.js";
import { getCronStoreKysely } from "../../../cron/store/schema.js";
import type { CronStoredJob } from "../../../cron/types.js";
import { runLegacyCronHealth } from "../../../flows/doctor-health-contribution-runners.state.js";
import { legacyMemberSnapshot } from "../../../gateway/openclaw-id/member-source-role-import.test-support.js";
import { migrateCronInferenceStandingGrantReferences } from "../../../gateway/operator-approval-standing-grants.worker.js";
import { executeSqliteQuerySync } from "../../../infra/kysely-sync.js";
import { runOpenClawStateWriteTransaction } from "../../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  prepareDoctorContext,
  withDoctorConfigMaintenance,
} from "../../doctor-config-flow.test-support.js";
import { maybeRepairCronInferenceBindings } from "./inference-binding-migration.js";
import { inspectCronJobsForDoctor } from "./store-repair.js";

it("backs up captured accounts, converts exact routes, and pauses mismatches without deleting rows", async () => {
  await withOpenClawTestState({ label: "cron-pin-migration" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: {
        entries: {
          main: { agentDir: state.agentDir(), workspace: state.workspaceDir },
          mismatch: {
            agentDir: state.agentDir("mismatch"),
            workspace: state.workspaceDir,
            model: "anthropic/claude-sonnet-4-6",
          },
        },
        defaults: { model: { primary: "openai/gpt-4.1", fallbacks: ["openai/gpt-4.1-mini"] } },
      },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    await persistAuthProfileBatch({
      profiles: [
        {
          profileId: "openai:reports",
          credential: { type: "api_key", provider: "openai", key: "synthetic-reports-key" },
        },
      ],
    });
    const authorization = await captureAuthProfileAuthorization({
      profileId: "openai:reports",
      cfg,
      agentDir: state.agentDir(),
      assertCurrent() {},
    });
    const binding = {
      version: 1,
      provider: "openai",
      profileId: "openai:reports",
      authorizationId: authorization.authorizationId,
      authRequirement: "api-key",
      runtime: "openclaw",
      source: "auto",
    } as const;
    authorization.dispose();
    // This captured account survived publication of an older updater's private state copy.
    const shadowRoot = state.statePath(".upgrade-example-123-456", "state");
    const shadow = await captureAuthProfileAuthorization({
      cfg,
      profileId: binding.profileId,
      agentDir: state.agentDir(),
      publishedStateDir: shadowRoot,
      assertCurrent() {},
    });
    const shadowBinding = { ...binding, authorizationId: shadow.authorizationId };
    shadow.dispose();
    await state.writeJson(".upgraded-example.json", {
      appVersion: "example",
      ops: [
        {
          kind: "replace",
          live: state.statePath("state", "openclaw.sqlite"),
          next: state.statePath(".upgrade-example-123-456", "state", "state", "openclaw.sqlite"),
        },
      ],
    });
    const source = {
      version: 1,
      kind: "gateway",
      agentId: "main",
      sourceRunId: "legacy-run",
      snapshot: legacyMemberSnapshot(),
    } as const;
    const storePath = state.statePath("cron", "jobs.json");
    const job = (id: string, model?: string): CronStoredJob => ({
      id,
      name: id,
      agentId: "main",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 2,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
      wakeMode: "now",
      sessionTarget: "isolated",
      delivery: { mode: "none" },
      payload: {
        kind: "agentTurn",
        message: "Prepare the weekly report",
        ...(model ? { model } : {}),
      },
      state: { lastRunAtMs: 123, lastRunStatus: "ok" },
    });
    await saveCronJobsStore(storePath, {
      version: 1,
      jobs: [
        job("inherit"),
        job("revoked", "openai/gpt-4.1@openai:reports"),
        { ...job("mismatch"), agentId: "mismatch" },
        job("unbound"),
        {
          ...job("explicit", "openai/gpt-4.1-mini@openai:reports"),
          cyberAccessProgram: "daybreak_blue",
        },
      ],
    });
    const original = await inspectCronJobsForDoctor({ env: process.env });
    runOpenClawStateWriteTransaction(({ db }) => {
      for (const row of original.jobs.filter(({ id }) => id !== "unbound")) {
        const storedBinding = row.id === "explicit" ? shadowBinding : binding;
        const { state: _state, ...executionDefinition } = row.definition!;
        const executionRevision = hashCronJobDefinition({
          ...executionDefinition,
          inferenceBinding: storedBinding,
        });
        const { enabled: _enabled, ...grantDefinition } = executionDefinition;
        executeSqliteQuerySync(
          db,
          getCronStoreKysely(db)
            .updateTable("cron_jobs")
            .set({
              job_json: JSON.stringify({
                ...row.definition,
                inferenceBinding:
                  row.id === "revoked"
                    ? { ...binding, authorizationId: "a".repeat(64) }
                    : storedBinding,
                ...(row.id === "inherit" ? { operatorSource: { source, executionRevision } } : {}),
              }),
              ...(row.id === "explicit"
                ? {
                    grant_definition_revision: hashCronJobDefinition({
                      ...grantDefinition,
                      inferenceBinding: storedBinding,
                    }),
                  }
                : {}),
            })
            .where("store_key", "=", row.storeKey)
            .where("job_id", "=", row.id),
        );
      }
    });
    expect((await loadCronJobsStore(storePath)).jobs.map(({ id }) => id)).toEqual(["unbound"]);
    const pending = await inspectCronJobsForDoctor({ env: process.env });
    expect(
      (await maybeRepairCronInferenceBindings({ cfg, shouldRepair: false })).warnings,
    ).toHaveLength(4);
    expect(await inspectCronJobsForDoctor({ env: process.env })).toEqual(pending);
    const changes: string[] = [];
    const pauseReason =
      "Paused because the current model no longer matches the saved account’s provider. Review its model and account before enabling it.";
    const pauseNotice = `Automation mismatch (mismatch): ${pauseReason}`;
    const notes = vi.spyOn(noteModule, "note").mockImplementation((message) => {
      changes.push(...String(message).split("\n"));
    });
    try {
      await withDoctorConfigMaintenance(async () => {
        await using ctx = await prepareDoctorContext(state.configPath);
        await runLegacyCronHealth(ctx);
        expect(ctx.updateWarnings ?? []).toEqual(expect.arrayContaining([pauseNotice]));
        const previous = job("inherit");
        const model = "openai/gpt-4.1@openai:reports";
        // A verified billing change cannot carry the previous approval to a different task.
        expect(() =>
          runOpenClawStateWriteTransaction(({ db }) =>
            migrateCronInferenceStandingGrantReferences(
              db,
              previous,
              {
                ...previous,
                modelAuthProfileAuthorizationId: binding.authorizationId,
                payload: {
                  kind: "agentTurn",
                  model,
                  modelRuntime: binding.runtime,
                  message: "Run a different task",
                },
              },
              1,
              { binding, model, authorizationId: binding.authorizationId },
            ),
          ),
        ).toThrow("preserve the entire approved job definition");
      });
    } finally {
      notes.mockRestore();
    }
    const result = { changes };
    expect(result.changes).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "inherit (inherit): pinned openai/gpt-4.1@openai:reports on openclaw",
        ),
        expect.stringContaining(
          "explicit (explicit): pinned openai/gpt-4.1-mini@openai:reports on openclaw",
        ),
        expect.stringMatching(/revoked \(revoked\): [Pp]aused because/u),
        pauseNotice,
      ]),
    );
    const backup = result.changes.find((line) => line.startsWith("Saved pre-repair cron backup: "));
    expect(backup).toBeDefined();
    expect(
      (await fs.stat(backup!.replace("Saved pre-repair cron backup: ", ""))).size,
    ).toBeGreaterThan(0);
    const saved = (await loadCronJobsStore(storePath)).jobs;
    expect(saved).toHaveLength(5);
    for (const migrated of saved) {
      expect(migrated).not.toHaveProperty("inferenceBinding");
      expect(migrated.state.lastRunAtMs).toBe(123);
    }
    const inherited = saved.find(({ id }) => id === "inherit")!;
    expect(inherited).toMatchObject({
      enabled: true,
      payload: { model: "openai/gpt-4.1@openai:reports", modelRuntime: "openclaw" },
      modelAuthProfileAuthorizationId: binding.authorizationId,
    });
    expect(inherited.operatorSource).toEqual({
      source,
      executionRevision: resolveCronOperatorExecutionRevision(inherited),
    });
    expect(saved.find(({ id }) => id === "explicit")).toMatchObject({
      enabled: true,
      cyberAccessProgram: "daybreak_blue",
      modelAuthProfileAuthorizationId: binding.authorizationId,
      payload: {
        kind: "agentTurn",
        model: "openai/gpt-4.1-mini@openai:reports",
        modelRuntime: "openclaw",
      },
    });
    expect(saved.find(({ id }) => id === "revoked")).toMatchObject({
      enabled: false,
      payload: { model: "openai/gpt-4.1@openai:reports" },
      modelAuthProfileAuthorizationId: "a".repeat(64),
    });
    const mismatch = saved.find(({ id }) => id === "mismatch")!;
    expect(cronJobReadView(mismatch)).toMatchObject({
      enabled: false,
      inferenceAccountPauseReason: pauseReason,
      state: { lastRunAtMs: 123, lastRunStatus: "ok" },
    });
    expect(mismatch.payload).not.toHaveProperty("model");
    const repaired = await inspectCronJobsForDoctor({ env: process.env });
    expect(repaired.jobs.find(({ id }) => id === "explicit")?.definition).toMatchObject({
      cyberAccessProgram: "daybreak_blue",
      payload: { kind: "accessAgentTurn", model: "openai/gpt-4.1-mini@openai:reports" },
    });
    expect(repaired.jobs.find(({ id }) => id === "unbound")).toEqual(
      original.jobs.find(({ id }) => id === "unbound"),
    );
    expect(
      await withDoctorConfigMaintenance(() =>
        maybeRepairCronInferenceBindings({ cfg, shouldRepair: true }),
      ),
    ).toMatchObject({
      changes: [],
      notices: expect.arrayContaining([pauseNotice]),
      warnings: [],
    });
    applyJobPatch(mismatch, {
      enabled: true,
      payload: {
        kind: "agentTurn",
        message: "Prepare the weekly report",
        model: "openai/gpt-4.1@openai:reports",
      },
    });
    expect(cronJobReadView(mismatch)).not.toHaveProperty("inferenceAccountPauseReason");
  });
});
