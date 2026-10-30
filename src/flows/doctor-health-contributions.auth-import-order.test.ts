import fs from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, aroundEach, describe, expect, it, vi } from "vitest";
import {
  loadPersistedAuthProfileStore,
  loadPersistedSharedAuthProfileStore,
} from "../agents/auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import {
  prepareAuthProfileSourceReceipt,
  type AuthProfileMigrationSourceReceipt,
} from "../commands/doctor-auth-migration-receipts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { runAuthProfileMigration } from "./doctor-auth-health.js";
import {
  createDoctorHealthFlowContext,
  createDoctorPrompterFixture,
} from "./doctor-health-context.test-support.js";
import { showDoctorHealthSummary } from "./doctor-health-contribution.js";

// mock-isolation: Scenario fixtures own credential state and migration outcomes; isolate filesystem writes and provider login effects proved by their owner suites.
vi.mock("../commands/doctor-auth-legacy-oauth.js", () => ({
  maybeRepairLegacyOAuthProfileIds: vi.fn(async (config: OpenClawConfig) => ({
    config,
    retiredProfileCleanupPlans: [],
    findings: [],
  })),
}));

vi.mock("../commands/doctor-model-catalog-credentials.js", () => ({
  maybeMigrateModelCatalogCredentials: vi.fn(async () => undefined),
}));

let testState: OpenClawTestState;
const { recordAuthProfileMigrationImported } = (globalThis as Record<PropertyKey, unknown>)[
  Symbol.for("openclaw.authProfileMigrationReceiptsTestApi")
] as {
  recordAuthProfileMigrationImported: (receipt: AuthProfileMigrationSourceReceipt) => void;
};

function makePrompter(shouldRepair: boolean) {
  return {
    ...createDoctorPrompterFixture(shouldRepair, true),
    confirm: vi.fn(async () => false),
    confirmAggressiveAutoFix: vi.fn(async () => false),
    confirmRuntimeRepair: vi.fn(async () => false),
  };
}

function makeLegacyConfig(): OpenClawConfig {
  return {
    auth: {
      profiles: {
        "openai:bravo": { provider: "openai", mode: "api_key" },
        "openai-codex:bravo": { provider: "openai-codex", mode: "oauth" },
      },
      order: { "openai-codex": ["openai-codex:bravo"] },
    },
  };
}

async function writeLegacyRotationState(state: OpenClawTestState): Promise<string> {
  return await state.writeJson("agents/main/agent/auth-state.json", {
    version: 1,
    order: { "openai-codex": ["openai-codex:bravo"] },
    lastGood: { "openai-codex": "openai-codex:bravo" },
    usageStats: { "openai-codex:bravo": { lastUsed: 123 } },
  });
}

async function writeLegacyCredentialStore(state: OpenClawTestState): Promise<string> {
  return await state.writeJson("agents/main/agent/auth-profiles.json", {
    version: 1,
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
  });
}

function context(state: OpenClawTestState, shouldRepair: boolean) {
  const cfg = makeLegacyConfig();
  return createDoctorHealthFlowContext({
    cfg,
    cfgForPersistence: shouldRepair ? structuredClone(cfg) : cfg,
    prompter: makePrompter(shouldRepair),
    env: state.env,
    configPath: path.join(state.stateDir, "openclaw.json"),
  });
}

function loadMigratedStore(state: OpenClawTestState) {
  return (
    loadPersistedAuthProfileStore(state.agentDir()) ??
    loadPersistedSharedAuthProfileStore(state.env)
  );
}

aroundEach((runTest) =>
  withOpenClawTestState(
    {
      layout: "state-only",
      prefix: "openclaw-doctor-auth-import-order-",
      env: { OPENCLAW_AGENT_DIR: undefined },
    },
    async (current) => {
      testState = current;
      await runTest();
    },
  ),
);
afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeAuthProfileStoreSnapshots();
});

describe("interactive Doctor auth migration", () => {
  it.each(["failed", "declined"] as const)(
    "reports interrupted archive recovery when the remaining migration is %s",
    async (outcome) => {
      const state = testState;
      const sourcePath = await state.writeText("credentials/oauth.json", "{}\n");
      const sourceBytes = fs.readFileSync(sourcePath);
      const receipt = prepareAuthProfileSourceReceipt({
        pathname: sourcePath,
        now: Date.now,
        targetDatabasePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
        targetTable: "auth_profile_store",
        env: state.env,
      });
      recordAuthProfileMigrationImported(receipt);
      if (outcome === "failed") {
        // A persisted receipt with an invalid target cannot be safely resumed.
        openOpenClawStateDatabase({ env: state.env })
          .db.prepare("UPDATE migration_sources SET target_table = ? WHERE source_key = ?")
          .run("invalid_target", receipt.sourceKey);
      }
      const remainingPath = outcome === "declined" ? await writeLegacyCredentialStore(state) : null;
      const statePath = outcome === "declined" ? await writeLegacyRotationState(state) : null;
      const ctx = context(state, false);
      const originalConfig = structuredClone(ctx.cfg);
      const { prompter } = ctx;
      const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

      await runAuthProfileMigration(ctx);
      showDoctorHealthSummary(ctx);
      const summary = vi
        .mocked(ctx.runtime.log)
        .mock.calls.map(([message]) => message)
        .join("\n");

      const output = stripVTControlCharacters(
        stdout.mock.calls.map(([chunk]) => String(chunk)).join(""),
      )
        .replaceAll("│", "")
        .replace(/\s+/g, " ");
      stdout.mockRestore();
      if (outcome === "failed") {
        expect(output).not.toContain("Doctor warnings");
        expect(summary).not.toContain("Historical recovery notices");
        expect(summary).not.toContain("Could not finalize an interrupted auth profile archive");
        expect(ctx.updateWarnings).toEqual([
          expect.stringContaining("Could not finalize an interrupted auth profile archive"),
        ]);
        expect(fs.readFileSync(sourcePath)).toEqual(sourceBytes);
        expect(fs.existsSync(receipt.archivePath)).toBe(false);
      } else {
        expect(output).toContain("Doctor changes");
        expect(output.match(/Finalized interrupted auth profile archive/g)).toHaveLength(1);
        expect(fs.existsSync(sourcePath)).toBe(false);
        expect(fs.readFileSync(receipt.archivePath)).toEqual(sourceBytes);
      }
      if (remainingPath) {
        expect(prompter.confirmAutoFix).toHaveBeenCalledOnce();
        expect(fs.existsSync(remainingPath)).toBe(true);
        expect(statePath && fs.existsSync(statePath)).toBe(true);
        expect(ctx.cfg).toEqual(originalConfig);
        expect(loadMigratedStore(state)).toBeNull();
      } else {
        expect(prompter.confirmAutoFix).not.toHaveBeenCalled();
      }
    },
  );

  it("commits config credentials and standalone state with one mapping after acceptance", async () => {
    const state = testState;
    await writeLegacyCredentialStore(state);
    await writeLegacyRotationState(state);
    const ctx = context(state, true);

    await runAuthProfileMigration(ctx);

    expect(loadMigratedStore(state)).toMatchObject({
      profiles: {
        "openai:bravo": { key: "existing-key" },
        "openai:chatgpt-bravo": { access: "legacy-access" },
      },
      order: { openai: ["openai:chatgpt-bravo"] },
      lastGood: { openai: "openai:chatgpt-bravo" },
      usageStats: { "openai:chatgpt-bravo": { lastUsed: 123 } },
    });
    expect(ctx.cfg.auth?.profiles).toHaveProperty("openai:chatgpt-bravo");
    expect(ctx.healthFindings ?? []).toEqual([]);
    expect(ctx.cfg.auth?.profiles).not.toHaveProperty("openai-codex:bravo");
    expect(ctx.cfg.auth?.order?.openai).toEqual(["openai:chatgpt-bravo"]);
  });
});
