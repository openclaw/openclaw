import fs from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import * as authStore from "../agents/auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import * as authMigration from "../commands/doctor-auth-migration-receipts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import * as stateDb from "../state/openclaw-state-db.js";
import * as testState from "../test-utils/openclaw-test-state.js";
import {
  createDoctorHealthFlowContext,
  createDoctorPrompterFixture,
  resolveDoctorHealthContributions,
} from "./doctor-health-contributions.test-support.js";

vi.mock("../commands/doctor-auth-legacy-oauth.js", () => ({
  maybeRepairLegacyOAuthProfileIds: vi.fn(async (config: OpenClawConfig) => ({
    config,
    retiredProfileCleanupPlans: [],
  })),
}));

vi.mock("../commands/doctor-model-catalog-credentials.js", () => ({
  maybeMigrateModelCatalogCredentials: vi.fn(async () => undefined),
}));

vi.mock("../commands/doctor-auth.js", () => ({
  noteAuthProfileHealth: vi.fn(async () => undefined),
  noteCopilotAmbientToken: vi.fn(),
  noteLegacyCodexProviderOverride: vi.fn(() => undefined),
  noteSharedAuthStoreStatus: vi.fn(() => undefined),
}));

const states: testState.OpenClawTestState[] = [];
const { recordAuthProfileMigrationImported } = (globalThis as Record<PropertyKey, unknown>)[
  Symbol.for("openclaw.authProfileMigrationReceiptsTestApi")
] as {
  recordAuthProfileMigrationImported: (
    receipt: authMigration.AuthProfileMigrationSourceReceipt,
  ) => void;
};

async function makeFixture(shouldRepair = false) {
  const state = await testState.createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-doctor-auth-import-order-",
    env: { OPENCLAW_AGENT_DIR: undefined },
  });
  states.push(state);
  const cfg = {
    auth: {
      profiles: {
        "openai:bravo": { provider: "openai", mode: "api_key" },
        "openai-codex:bravo": { provider: "openai-codex", mode: "oauth" },
      },
      order: { "openai-codex": ["openai-codex:bravo"] },
    },
  } as OpenClawConfig;
  const prompter = createDoctorPrompterFixture(false);
  Object.assign(prompter, { confirmAutoFix: vi.fn(async () => shouldRepair), shouldRepair });
  Object.assign(prompter.repairMode, { shouldRepair, nonInteractive: false, canPrompt: true });
  const ctx = createDoctorHealthFlowContext({
    cfg,
    cfgForPersistence: structuredClone(cfg),
    prompter,
    env: state.env,
    configPath: path.join(state.stateDir, "openclaw.json"),
  });
  const contribution = resolveDoctorHealthContributions().find(
    (entry) => entry.id === "doctor:auth-profile-migration",
  );
  if (!contribution) {
    throw new Error("Missing doctor:auth-profile-migration");
  }
  return {
    state,
    ctx,
    run: () => contribution.run(ctx),
    loadStore: () =>
      authStore.loadPersistedAuthProfileStore(state.agentDir()) ??
      authStore.loadPersistedSharedAuthProfileStore(state.env),
  };
}

async function writeLegacyFiles(state: testState.OpenClawTestState) {
  const files = {
    "auth-state": {
      order: { "openai-codex": ["openai-codex:bravo"] },
      lastGood: { "openai-codex": "openai-codex:bravo" },
      usageStats: { "openai-codex:bravo": { lastUsed: 123 } },
    },
    "auth-profiles": {
      profiles: {
        "openai:bravo": { type: "api_key", provider: "openai", key: "existing-key" },
        "openai-codex:bravo": {
          type: "oauth",
          provider: "openai-codex",
          access: "legacy-access",
          refresh: "legacy-refresh",
          expires: 1_900_000_000_000,
        },
      },
    },
  };
  return Promise.all(
    Object.entries(files).map(([name, data]) =>
      state.writeJson(`agents/main/agent/${name}.json`, { version: 1, ...data }),
    ),
  );
}

afterEach(async () => {
  vi.restoreAllMocks();
  clearRuntimeAuthProfileStoreSnapshots();
  closeOpenClawAgentDatabasesForTest();
  stateDb.closeOpenClawStateDatabaseForTest();
  await Promise.all(states.splice(0).map((state) => state.cleanup()));
});

it.each(["failed", "declined"] as const)(
  "reports interrupted archive recovery when the remaining migration is %s",
  async (outcome) => {
    const { state, ctx, run, loadStore } = await makeFixture();
    const sourcePath = await state.writeText("credentials/oauth.json", "{}\n");
    const sourceBytes = fs.readFileSync(sourcePath);
    const receipt = authMigration.createAuthProfileMigrationSourceReceipt({
      sourcePath,
      sourceBytes,
      sourceRecordCount: 0,
      targetDatabasePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
      targetTable: "auth_profile_store",
      env: state.env,
    });
    recordAuthProfileMigrationImported(receipt);
    if (outcome === "failed") {
      stateDb
        .openOpenClawStateDatabase({ env: state.env })
        .db.prepare("UPDATE migration_sources SET target_table = ? WHERE source_key = ?")
        .run("invalid_target", receipt.sourceKey);
    }
    const remainingPaths = outcome === "declined" ? await writeLegacyFiles(state) : [];
    const originalConfig = structuredClone(ctx.cfg);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await run();

    const output = stripVTControlCharacters(
      stdout.mock.calls.map(([chunk]) => String(chunk)).join(""),
    )
      // Notes draw ASCII borders where Unicode is unsupported (for example TERM=linux).
      .replace(/[│|]/gu, "")
      .replace(/\s+/g, " ");
    stdout.mockRestore();
    const failed = outcome === "failed";
    const notice = failed
      ? "Could not finalize an interrupted auth profile archive"
      : "Finalized interrupted auth profile archive";
    expect(output).toContain(failed ? "Doctor warnings" : "Doctor changes");
    expect(output.match(new RegExp(notice, "g"))).toHaveLength(1);
    expect(fs.readFileSync(failed ? sourcePath : receipt.archivePath)).toEqual(sourceBytes);
    expect(fs.existsSync(failed ? receipt.archivePath : sourcePath)).toBe(false);
    if (failed) {
      expect(output).toContain("invalid pending auth profile migration receipt");
    }
    if (remainingPaths.length) {
      expect(ctx.prompter.confirmAutoFix).toHaveBeenCalledOnce();
      expect(remainingPaths.map((file) => fs.existsSync(file))).toEqual([true, true]);
      expect(ctx.cfg).toEqual(originalConfig);
      expect(loadStore()).toBeNull();
    } else {
      expect(ctx.prompter.confirmAutoFix).not.toHaveBeenCalled();
    }
  },
);

it("commits config credentials and standalone state with one mapping after acceptance", async () => {
  const { state, ctx, run, loadStore } = await makeFixture(true);
  await writeLegacyFiles(state);

  await run();

  expect(loadStore()).toMatchObject({
    profiles: {
      "openai:bravo": { key: "existing-key" },
      "openai:chatgpt-bravo": { access: "legacy-access" },
    },
    order: { openai: ["openai:chatgpt-bravo"] },
    lastGood: { openai: "openai:chatgpt-bravo" },
    usageStats: { "openai:chatgpt-bravo": { lastUsed: 123 } },
  });
  expect(ctx.cfg.auth?.profiles).toHaveProperty("openai:chatgpt-bravo");
  expect(ctx.cfg.auth?.profiles).not.toHaveProperty("openai-codex:bravo");
  expect(ctx.cfg.auth?.order?.openai).toEqual(["openai:chatgpt-bravo"]);
});
