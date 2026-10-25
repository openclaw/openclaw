import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { prepareRecoveryHolds } from "../agents/agent-create.integration.test-support.js";
import { runMigrationApply } from "../commands/migrate/apply.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import type { MigrationProviderPlugin } from "../plugins/migration-provider.types.js";
import { readAgentProvenance } from "../test-utils/agent-provenance.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createMigrationAgent } from "./migration-runtime.js";
import { summarizeMigrationItems } from "./migration.js";
import type { MigrationProviderContext } from "./plugin-entry.js";

it("creates an imported agent through offline migration, preserves existing state, and safely retries", async () => {
  const state = await createOpenClawTestState({ scenario: "minimal", label: "migration-agent" });
  onTestFinished(state.cleanup);
  await state.writeConfig({
    agents: { entries: { main: { name: "Original", workspace: state.workspaceDir } } },
    messages: { ackReaction: "🦞" },
  });
  const original = "Existing user instructions.\n";
  await fs.writeFile(path.join(state.workspaceDir, "AGENTS.md"), original);
  const definition = {
    id: "imported-researcher",
    name: "Imported Researcher",
    workspace: state.path("imported-workspace"),
    agentDir: state.agentDir("imported-researcher"),
    model: "openai/gpt-5.5",
    identity: { name: "Researcher", avatar: "avatars/researcher.png" },
  };
  let result: Awaited<ReturnType<typeof createMigrationAgent>> | undefined;
  let staged = false;
  const provider: MigrationProviderPlugin = {
    id: "fixture",
    label: "Fixture",
    plan: () => ({
      providerId: "fixture",
      source: "synthetic",
      items: [],
      summary: summarizeMigrationItems([]),
    }),
    async apply(ctx, plan) {
      result = await createMigrationAgent(
        staged ? { ...ctx, stateDir: state.path("staging") } : ctx,
        definition,
      );
      return plan!;
    },
  };
  const apply = () =>
    runMigrationApply({
      provider,
      providerId: provider.id,
      opts: { noBackup: true, json: true },
      runtime: {
        log() {},
        error() {},
        exit(code) {
          throw new Error(`Unexpected migration exit ${code}`);
        },
      },
    });

  staged = true;
  await apply();
  expect(result).toMatchObject({ status: "error", reason: expect.stringContaining("promotion") });
  await expect(fs.stat(definition.workspace)).rejects.toMatchObject({ code: "ENOENT" });
  staged = false;
  await apply();
  expect(result, JSON.stringify(result)).toMatchObject({
    status: "created",
    agentId: definition.id,
  });
  const config = JSON.parse(await fs.readFile(state.configPath, "utf8")) as OpenClawConfig;
  expect(config.agents?.entries?.[definition.id]).toMatchObject({
    name: definition.name,
    workspace: definition.workspace,
    agentDir: definition.agentDir,
    model: definition.model,
    identity: definition.identity,
  });
  expect(config.agents?.entries?.main?.name).toBe("Original");
  expect(config.messages?.ackReaction).toBe("🦞");
  expect(await fs.readFile(path.join(state.workspaceDir, "AGENTS.md"), "utf8")).toBe(original);
  expect(readAgentProvenance(definition.id, { env: state.env })).toMatchObject({
    createdVia: "operator",
  });
  await expect(
    fs.stat(path.join(definition.agentDir, "openclaw-agent.sqlite")),
  ).resolves.toBeDefined();

  const configBytes = await fs.readFile(state.configPath, "utf8");
  await apply();
  expect(result).toMatchObject({ status: "existing", agentId: definition.id });
  expect(await fs.readFile(state.configPath, "utf8")).toBe(configBytes);

  definition.name = "Unrelated replacement";
  await apply();
  expect(result).toMatchObject({ status: "conflict" });
  expect(await fs.readFile(state.configPath, "utf8")).toBe(configBytes);

  const recovery = await prepareRecoveryHolds(state, definition.id, [
    { agentId: definition.id, path: path.join(definition.agentDir, "openclaw-agent.sqlite") },
  ]);
  for (const name of ["Unrelated replacement", "Imported Researcher"]) {
    definition.name = name;
    await apply();
    expect.soft(result).toMatchObject({ status: "conflict" });
    expect.soft(recovery.readHolds()).toEqual(recovery.held);
    expect.soft(await fs.readFile(state.configPath, "utf8")).toBe(configBytes);
    expect
      .soft(await Promise.all(recovery.held.map((target) => fs.readFile(target.path))))
      .toEqual(recovery.bytes);
  }
});

it("stops migrated agent creation when offline ownership closes during workspace preparation", async ({
  signal,
}) => {
  const state = await createOpenClawTestState({ scenario: "minimal", label: "migration-owner" });
  onTestFinished(state.cleanup);
  const config = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
  await state.writeConfig(config);
  const originalConfig = await fs.readFile(state.configPath, "utf8");
  const definition = {
    id: "revoked-import",
    name: "Revoked Import",
    workspace: state.path("revoked-workspace"),
    agentDir: state.agentDir("revoked-import"),
  };
  const ctx: MigrationProviderContext = {
    config,
    stateDir: state.stateDir,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
  const owner = await acquireGatewayLock({
    env: state.env,
    role: "agent-embedded",
    allowInTests: true,
    timeoutMs: 0,
  });
  if (!owner) {
    throw new Error("Expected offline migration ownership");
  }
  const prepared = createDeferred();
  const resume = createDeferred();
  const mkdir = fs.mkdir.bind(fs);
  const pause = vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
    const result = await mkdir(...args);
    if (args[0] === definition.workspace) {
      prepared.resolve();
      await resume.promise;
    }
    return result;
  });
  const creation = owner.run(() => createMigrationAgent(ctx, definition));
  try {
    await withinTest(
      awaitGateBeforeSettlement(prepared.promise, creation, "creation settled before preparation"),
      signal,
    );
    await owner.release();
    resume.resolve();
    expect(await creation).toMatchObject({
      status: "error",
      reason: expect.stringContaining("state database is busy"),
    });
    expect(await fs.readFile(state.configPath, "utf8")).toBe(originalConfig);
    expect(await fs.readdir(definition.workspace)).toEqual([]);
    for (const target of [state.sessionsDir(definition.id), definition.agentDir]) {
      await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(readAgentProvenance(definition.id, { env: state.env })).toBeUndefined();
  } finally {
    resume.resolve();
    await creation;
    pause.mockRestore();
    await owner.release();
  }
});
