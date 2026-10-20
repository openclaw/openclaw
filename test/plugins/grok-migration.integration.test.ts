import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { buildGrokMigrationProvider } from "../../extensions/migrate-grok/api.js";
import { ensureAuthProfileStoreWithoutExternalProfilesAsync } from "../../src/agents/auth-profiles/store-runtime.js";
import { runWithLocalStateOwner } from "../../src/cli/local-state-owner.js";
import { runMigrationApply } from "../../src/commands/migrate/apply.js";
import { buildMigrationContext } from "../../src/commands/migrate/context.js";
import { applyMigrationSelections } from "../../src/commands/migrate/selection.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { loadCronStore, resolveCronStorePathAsync } from "../../src/cron/store.js";
import { createPluginRuntime } from "../../src/plugins/runtime/index.js";
import { createOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";

it("migrates verified offline Grok configuration through native owners and safely retries", async () => {
  const state = await createOpenClawTestState({ scenario: "minimal", label: "grok-migration" });
  onTestFinished(state.cleanup);
  await state.writeConfig({
    agents: { entries: { main: { name: "Original", workspace: state.workspaceDir } } },
    messages: { ackReaction: "🦞" },
  });
  const originalInstructions = "Keep the existing user's instructions.\n";
  const originalMemory = "Existing memory must remain.\n";
  await fs.writeFile(path.join(state.workspaceDir, "AGENTS.md"), originalInstructions);
  await fs.writeFile(path.join(state.workspaceDir, "MEMORY.md"), originalMemory);
  const source = state.path("source", "grok-migration.json");
  const providerKey = "synthetic-openai-migration-key";
  const mcpKey = "synthetic-mcp-migration-key";
  const snapshot = {
    format: "grok-migration",
    version: 1,
    mainAgentId: "primary-source",
    settings: { userTimeZoneOverride: "America/Los_Angeles" },
    agents: [
      {
        id: "primary-source",
        profile: {
          name: "Primary",
          description: "Complete primary instructions, including the final sentence.",
          avatarShape: "hexagon",
          avatarColor: "#9159FE",
        },
        memory: [{ kind: "profile", content: "Complete primary memory." }],
        skills: [
          { name: "Research", description: "Find evidence", content: "Complete research skill." },
        ],
        routines: [],
        plugins: [],
        automations: [],
      },
      {
        id: "secondary-source",
        profile: {
          name: "Researcher",
          description: "Complete secondary instructions, including the final sentence.",
          avatarShape: "hexagon",
          avatarColor: "#27AE60",
        },
        memory: [{ kind: "profile", content: "Complete secondary memory." }],
        skills: [
          { name: "Analyze", description: "Analyze findings", content: "Complete analysis skill." },
        ],
        routines: [],
        plugins: [],
        automations: [
          {
            id: "morning-research",
            name: "Morning research",
            prompt: "Read the complete research brief and summarize the evidence.",
            trigger: { type: "cron", schedule: "15 9 * * 1-5" },
            isEnabled: true,
          },
        ],
      },
    ],
    mcpConfig: {
      mcpServers: {
        fixture: { command: "fixture-mcp", args: ["serve"], env: { API_KEY: mcpKey } },
      },
    },
    credentialNames: ["OPENAI_API_KEY"],
  };
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, JSON.stringify(snapshot));
  const secretsFile = path.join(path.dirname(source), "secrets.json");
  await fs.writeFile(secretsFile, JSON.stringify({ OPENAI_API_KEY: providerKey }));
  const sourceBytes = await fs.readFile(source);
  const secretBytes = await fs.readFile(secretsFile);
  const originalConfig = await fs.readFile(state.configPath);
  const provider = buildGrokMigrationProvider({ runtime: createPluginRuntime() });
  const runtime = {
    log() {},
    error() {},
    exit(code: number): never {
      throw new Error(`Unexpected migration exit ${code}`);
    },
  };
  const plan = await provider.plan(
    buildMigrationContext({ source, targetAgentId: "main", includeSecrets: true, runtime }),
  );
  expect(plan.items.filter((item) => item.status === "conflict")).toMatchObject([
    { target: "agents.entries.main.name" },
  ]);
  const selected = applyMigrationSelections(plan, { skills: ["Research"] });
  expect(
    selected.items.filter((item) => item.kind === "skill" && item.status === "planned"),
  ).toHaveLength(1);
  expect(
    selected.items.find((item) => item.kind === "skill" && item.status === "planned")?.target,
  ).toBe(path.join(state.workspaceDir, "skills/research/SKILL.md"));
  expect(
    selected.items.find((item) => item.target?.endsWith("skills/analyze/SKILL.md"))?.status,
  ).toBe("skipped");
  expect(plan.items.some((item) => item.action === "create-agent")).toBe(true);
  expect(plan.items.some((item) => item.action === "create-cron")).toBe(true);
  expect(JSON.stringify(plan)).not.toContain(providerKey);
  expect(JSON.stringify(plan)).not.toContain(mcpKey);
  expect(await fs.readFile(state.configPath)).toEqual(originalConfig);
  expect(await fs.readFile(path.join(state.workspaceDir, "MEMORY.md"), "utf8")).toBe(
    originalMemory,
  );

  const apply = (overwrite = false) =>
    runMigrationApply({
      provider,
      providerId: "grok",
      opts: {
        source,
        targetAgentId: "main",
        includeSecrets: true,
        overwrite,
        noBackup: true,
        json: true,
        allowPartialResult: true,
      },
      runtime,
    });
  await expect(apply()).rejects.toThrow("Migration has 1 conflict");
  expect(await fs.readFile(state.configPath)).toEqual(originalConfig);
  // The reviewed name change is authorized explicitly; the retry below uses no overwrite.
  const result = await apply(true);
  const failed = result.items.filter((item) => ["error", "conflict"].includes(item.status));
  expect(failed, JSON.stringify(failed)).toEqual([]);
  expect(result.items.find((item) => item.action === "create-cron")?.details?.sourceEnabled).toBe(
    true,
  );
  expect(
    result.items.some(
      (item) => item.kind === "manual" && item.message?.includes("was enabled in Grok"),
    ),
  ).toBe(true);
  expect(
    result.items.some(
      (item) => item.kind === "manual" && item.message?.includes("per-agent scope"),
    ),
  ).toBe(true);
  const config = JSON.parse(await fs.readFile(state.configPath, "utf8")) as OpenClawConfig;
  const imported = Object.entries(config.agents?.entries ?? {}).find(([id]) => id !== "main");
  expect(imported).toBeDefined();
  const [importedId, importedAgent] = imported!;
  const importedWorkspace = importedAgent.workspace!;
  expect(Object.keys(config.agents?.entries ?? {})).toHaveLength(2);
  expect(importedAgent).toMatchObject({
    name: "Researcher",
    identity: { name: "Researcher", avatar: "assets/grok-avatar.svg" },
  });
  expect(config.agents?.entries?.main).toMatchObject({
    name: "Primary",
    identity: { name: "Primary", avatar: "assets/grok-avatar.svg" },
  });
  expect(config.messages?.ackReaction).toBe("🦞");
  expect(config.agents?.defaults?.userTimezone).toBe("America/Los_Angeles");
  expect(config.mcp?.servers?.fixture).toMatchObject({
    command: "fixture-mcp",
    args: ["serve"],
    transport: "stdio",
    enabled: false,
  });
  expect(config.mcp?.servers?.fixture?.env).toBeUndefined();
  expect(config.auth?.profiles).toBeUndefined();
  expect(await fs.readFile(path.join(state.workspaceDir, "AGENTS.md"), "utf8")).toBe(
    originalInstructions,
  );
  expect(await fs.readFile(path.join(state.workspaceDir, "SOUL.md"), "utf8")).toBe(
    snapshot.agents[0]!.profile.description,
  );
  expect(await fs.readFile(path.join(importedWorkspace, "SOUL.md"), "utf8")).toBe(
    snapshot.agents[1]!.profile.description,
  );
  expect(
    await fs.readFile(path.join(importedWorkspace, "skills/analyze/SKILL.md"), "utf8"),
  ).toContain("Complete analysis skill.");
  expect(
    await fs.readFile(path.join(importedWorkspace, "assets/grok-avatar.svg"), "utf8"),
  ).toContain("#27AE60");
  const primaryMemory = await fs.readFile(path.join(state.workspaceDir, "MEMORY.md"), "utf8");
  const secondaryMemory = await fs.readFile(path.join(importedWorkspace, "MEMORY.md"), "utf8");
  expect(primaryMemory.startsWith(originalMemory)).toBe(true);
  expect(primaryMemory).toContain("Complete primary memory.");
  expect(secondaryMemory).toContain("Complete secondary memory.");

  const readNativeState = () =>
    runWithLocalStateOwner({
      method: "migrate.apply",
      params: {},
      target: "Grok migration verification",
      onForeignOwner: "refuse",
      runLocal: async () => ({
        auth: await ensureAuthProfileStoreWithoutExternalProfilesAsync(state.agentDir(), {
          allowKeychainPrompt: false,
        }),
        importedAuth: await ensureAuthProfileStoreWithoutExternalProfilesAsync(
          state.agentDir(importedId),
          {
            allowKeychainPrompt: false,
          },
        ),
        cron: await loadCronStore(await resolveCronStorePathAsync()),
      }),
    });
  const persisted = await readNativeState();
  expect(
    Object.values(persisted.auth.profiles).some(
      (profile) => "key" in profile && profile.key === providerKey,
    ),
  ).toBe(false);
  expect(
    Object.values(persisted.importedAuth.profiles).some(
      (profile) => "key" in profile && profile.key === providerKey,
    ),
  ).toBe(false);
  expect(persisted.cron.jobs).toHaveLength(1);
  expect(persisted.cron.jobs[0]).toMatchObject({
    agentId: importedId,
    enabled: false,
    schedule: { kind: "cron", expr: "15 9 * * 1-5", tz: "America/Los_Angeles", staggerMs: 0 },
    payload: { kind: "agentTurn", message: snapshot.agents[1]!.automations[0]!.prompt },
    delivery: { mode: "none" },
  });
  expect(persisted.cron.jobs[0]?.state.lastRunAtMs).toBeUndefined();
  const report = await fs.readFile(path.join(result.reportDir!, "report.json"), "utf8");
  expect(report).not.toContain(providerKey);
  expect(report).not.toContain(mcpKey);

  const repeated = await apply();
  const retryFailures = repeated.items.filter((item) =>
    ["error", "conflict"].includes(item.status),
  );
  expect(retryFailures, JSON.stringify(retryFailures)).toEqual([]);
  expect(await fs.readFile(path.join(state.workspaceDir, "MEMORY.md"), "utf8")).toBe(primaryMemory);
  expect(await fs.readFile(path.join(importedWorkspace, "MEMORY.md"), "utf8")).toBe(
    secondaryMemory,
  );
  const afterRetry = JSON.parse(await fs.readFile(state.configPath, "utf8")) as OpenClawConfig;
  expect(afterRetry.agents?.entries).toEqual(config.agents?.entries);
  const retriedState = await readNativeState();
  expect(retriedState.cron.jobs).toEqual(persisted.cron.jobs);
  expect(retriedState.auth.profiles).toEqual(persisted.auth.profiles);
  // Onboarding recovery retains the reviewed plan after creating additional agents.
  // It must reuse that plan's primary destination even without an ambient selection.
  const recoveryPlan = structuredClone(result);
  for (const item of recoveryPlan.items) {
    if (item.action === "create-cron") {
      item.status = "planned";
    }
  }
  const recovered = await runMigrationApply({
    provider,
    providerId: "grok",
    opts: {
      source,
      includeSecrets: true,
      noBackup: true,
      json: true,
      allowPartialResult: true,
      preflightPlan: recoveryPlan,
    },
    runtime,
  });
  const recoveryFailures = recovered.items.filter((item) =>
    ["error", "conflict"].includes(item.status),
  );
  expect(recoveryFailures, JSON.stringify(recoveryFailures)).toEqual([]);
  expect(recovered.items.find((item) => item.action === "create-cron")?.status).toBe("migrated");
  expect((await readNativeState()).cron.jobs).toEqual(persisted.cron.jobs);
  expect(await fs.readFile(source)).toEqual(sourceBytes);
  expect(await fs.readFile(secretsFile)).toEqual(secretBytes);
});
