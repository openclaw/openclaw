import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { captureAuthProfileAuthorization } from "../../../agents/auth-profiles/authorization.js";
import {
  persistAuthProfileBatch,
  upsertAuthProfileWithLockOrThrow,
} from "../../../agents/auth-profiles/upsert-with-lock.js";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { captureCronInferenceBinding } from "../../../cron/inference-binding.runtime.js";
import { prepareCronRunInference } from "../../../cron/run-inference.js";
import { loadCronJobsStore, saveCronJobsStore } from "../../../cron/store.js";
import type { CronStoredJob } from "../../../cron/types.js";
import type { OpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import * as doctor from "../../doctor-config-flow.test-support.js";
import { maybeRepairCronInferenceBindings } from "./inference-binding-migration.js";

const withAccounts = (run: (state: OpenClawTestState) => Promise<void>) =>
  withOpenClawTestState(
    {
      label: "cron-inference-accounts",
      env: { OPENAI_API_KEY: undefined, OPENAI_OAUTH_TOKEN: undefined },
    },
    async (state) => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(
        new Error("No external I/O in offline migration"),
      );
      await run(state);
    },
  );

const saveProfiles = (...profiles: Parameters<typeof persistAuthProfileBatch>[0]["profiles"]) =>
  persistAuthProfileBatch({ profiles });
const saveJobs = (path: string, ...jobs: CronStoredJob[]) =>
  saveCronJobsStore(path, { version: 1, jobs });
const readJobs = async (path: string) => (await loadCronJobsStore(path)).jobs;
const apiProfile = (profileId: string, key: string) => ({
  profileId,
  credential: {
    type: "api_key" as const,
    provider: profileId.slice(0, profileId.indexOf(":")),
    key,
  },
});
async function configure(state: OpenClawTestState, cfg = config(state)) {
  await state.writeConfig(cfg);
  setRuntimeConfigSnapshot(cfg);
  return cfg;
}
const migrate = (cfg: OpenClawConfig, shouldRepair = true) =>
  maybeRepairCronInferenceBindings({ cfg, shouldRepair });

const config = (state: OpenClawTestState): OpenClawConfig => ({
  agents: {
    entries: { main: { agentDir: state.agentDir(), workspace: state.workspaceDir } },
    defaults: { model: "openai/gpt-5.5" },
  },
  plugins: { allow: ["openai"], slots: { memory: "none" } },
});

afterEach(() => vi.restoreAllMocks());

function legacyJob(id: string): CronStoredJob {
  return {
    id,
    name: id,
    agentId: "main",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 2,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message: "Synthetic scheduled work",
      fallbacks: ["openai/gpt-5.4"],
    },
    delivery: { mode: "none" },
    state: { lastRunAtMs: 123, lastRunStatus: "ok", consecutiveErrors: 2 },
  };
}

it("recovers only an old upgrade's path-bound jobs, without rerunning or reenabling them", async () => {
  await withAccounts(async (state) => {
    const cfg = await configure(state);
    const profileId = "openai:default";
    await saveProfiles(apiProfile(profileId, "fixture-key"));
    const current = await captureCronInferenceBinding({
      cfg,
      agentId: "main",
      model: `openai/gpt-5.5@${profileId}`,
    });
    if (!current) {
      throw new Error("Expected a stored profile binding");
    }
    const oldRoot = state.statePath(".upgrade-example-123-456", "state");
    const old = await captureAuthProfileAuthorization({
      cfg,
      profileId,
      agentDir: state.agentDir(),
      publishedStateDir: oldRoot,
      assertCurrent() {},
    });
    const broken = { ...current, authorizationId: old.authorizationId };
    old.dispose();
    expect(broken).not.toEqual(current);
    const store = state.statePath("cron", "jobs.json");
    const job = { ...legacyJob("missed"), enabled: false, inferenceBinding: broken };
    const refused = await prepareCronRunInference({
      job,
      cfg,
      agentDir: state.agentDir(),
      binding: broken,
    });
    try {
      expect(() => refused?.assertCandidate("openai", false)).toThrow(/replaced/);
    } finally {
      refused?.dispose();
    }
    await saveJobs(
      store,
      job,
      { ...job, id: "healthy", inferenceBinding: current },
      { ...job, id: "unrelated", inferenceBinding: { ...broken, authorizationId: "f".repeat(64) } },
    );
    const before = await readJobs(store);
    await doctor.withDoctorConfigMaintenance(async () => {
      const withoutReceipt = await migrate(cfg);
      expect(withoutReceipt.changes).toEqual([]);
      expect(withoutReceipt.warnings).toEqual([
        expect.stringMatching(/\(missed\).*no usable upgrade receipt/i),
        expect.stringMatching(/\(unrelated\).*no usable upgrade receipt/i),
      ]);
      expect(withoutReceipt.warnings[0]).toContain("openclaw models auth list --agent main");
      expect(withoutReceipt.warnings[0]).toContain(
        "openclaw automations edit missed --model 'openai/gpt-5.5@<profileId>'",
      );
      expect(await readJobs(store)).toEqual(before);
      await state.writeJson(".upgraded-example.json", {
        appVersion: "example",
        ops: [
          {
            kind: "replace",
            live: state.statePath("state", "openclaw.sqlite"),
            next: join(oldRoot, "state", "openclaw.sqlite"),
          },
        ],
      });
      expect((await migrate(cfg, false)).changes).toEqual([]);
      const repaired = await migrate(cfg);
      expect(repaired.changes.join("\n")).toContain("missed");
      expect(repaired.warnings).toEqual([
        expect.stringMatching(/\(unrelated\).*no usable upgrade receipt/i),
      ]);
      expect((await migrate(cfg)).changes).toEqual([]);
    });
    const after = await readJobs(store);
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    for (const [index, row] of before.entries()) {
      expect(after[index]).toEqual(row.id === job.id ? { ...row, inferenceBinding: current } : row);
    }
    const inference = await prepareCronRunInference({
      job,
      cfg,
      agentDir: state.agentDir(),
      binding: after.find((row) => row.id === job.id)?.inferenceBinding,
    });
    try {
      expect(inference).toBeDefined();
      inference?.assertCandidate("openai", false);
    } finally {
      inference?.dispose();
    }
    await upsertAuthProfileWithLockOrThrow(apiProfile(profileId, "fixture-replacement"));
    await saveJobs(store, job);
    await doctor.withDoctorConfigMaintenance(async () => {
      const replaced = await migrate(cfg);
      expect(replaced.changes).toEqual([]);
      expect(replaced.warnings).toEqual([
        expect.stringMatching(/\(missed\).*no usable upgrade receipt/i),
      ]);
    });
    expect((await readJobs(store))[0]?.inferenceBinding).toEqual(broken);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

// Unbound jobs select their account live like interactive turns (#202699); adoption would only pin them.
it("leaves unbound jobs unbound when a stored account is eligible", async () => {
  await withAccounts(async (state) => {
    const cfg = await configure(state);
    await saveProfiles(apiProfile("openai:default", "fixture-key"));
    const store = state.statePath("cron", "jobs.json");
    await saveJobs(store, legacyJob("unbound"));
    const before = await readJobs(store);
    await doctor.withDoctorConfigMaintenance(async () => {
      expect(await migrate(cfg)).toEqual({ changes: [], warnings: [] });
    });
    expect(await readJobs(store)).toEqual(before);
  });
});
