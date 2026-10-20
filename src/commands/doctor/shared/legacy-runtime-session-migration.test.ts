import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { recordDeferredPluginMigrations } from "../../../infra/deferred-plugin-migrations.js";
import { readDeferredPluginSessionImport } from "../../../infra/deferred-plugin-session-sources.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { seedDeferredPluginSessionSource } from "../../doctor-session-sqlite.deferred-plugin.test-support.js";
import { runDoctorSessionSqlite } from "../../doctor-session-sqlite.js";
import { maybeRepairCodexSessionRoutes } from "./codex-route-session-repair.js";

const states: OpenClawTestState[] = [];
const runtimeConfig: OpenClawConfig = {
  plugins: { enabled: false },
  agents: { entries: { main: {} }, defaults: { model: "openai/current-model" } },
};
const accountPin = {
  authProfileOverride: "authored:account",
  authProfileOverrideSource: "user" as const,
};
const bindings = { "claude-cli": { sessionId: "retained-binding" } };
async function createState(prefix: string) {
  const state = await createOpenClawTestState({ layout: "state-only", prefix });
  states.push(state);
  state.applyEnv();
  return state;
}
async function seedRuntimeSession(
  sessionId: string,
  entry: Omit<Parameters<typeof replaceSessionEntry>[1], "sessionId" | "updatedAt">,
) {
  const state = await createState(`runtime-${sessionId}-`);
  const scope = {
    storePath: path.join(state.sessionsDir(), "sessions.json"),
    sessionKey: `agent:main:${sessionId}`,
    env: state.env,
  };
  await replaceSessionEntry(scope, {
    sessionId,
    updatedAt: 1,
    ...accountPin,
    claudeCliSessionId: "retained-binding",
    ...entry,
  });
  const repair = (shouldRepair = true) =>
    maybeRepairCodexSessionRoutes({ cfg: runtimeConfig, env: state.env, shouldRepair });
  const before = loadSessionEntry(scope);
  await repair(false);
  expect(loadSessionEntry(scope)).toEqual(before);
  return { scope, repair };
}
async function expectStableRepair(
  scope: Parameters<typeof loadSessionEntry>[0],
  repair: () => ReturnType<typeof maybeRepairCodexSessionRoutes>,
) {
  const entry = loadSessionEntry(scope);
  expect(entry).not.toHaveProperty("claudeCliSessionId");
  expect((await repair()).repairedSessions).toBe(0);
  expect(loadSessionEntry(scope)).toEqual(entry);
}
afterEach(async () => {
  for (const state of states.splice(0)) {
    await state.cleanup();
  }
});

describe("legacy runtime session model migration", () => {
  it.each([false, true])(
    "repairs canonical routes without rewriting a receipted index (plugin completed: %s)",
    async (pluginCompleted) => {
      const state = await createState("retained-route-");
      const { cfg, storePath, scope } = await seedDeferredPluginSessionSource(state, "default");
      const sessionKey = "agent:main:kept";
      const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
      Object.assign(store[sessionKey], {
        modelProvider: "openai-codex",
        model: "current-model",
        claudeCliSessionId: "retained-binding",
      });
      fs.writeFileSync(storePath, JSON.stringify(store));
      expect(
        (await runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" }))
          .totals.importedEntries,
      ).toBe(2);
      const source = fs.readFileSync(storePath);
      const receiptParams = {
        cfg,
        env: state.env,
        target: { agentId: "main", storePath },
        sqlitePath: resolveSqliteTargetFromSessionStorePath(storePath, scope).path,
      };
      const receipt = readDeferredPluginSessionImport(receiptParams);
      expect(receipt).toBeDefined();
      if (pluginCompleted) {
        await recordDeferredPluginMigrations({
          env: state.env,
          pending: [],
          resolvedPluginIds: ["fixture-plugin"],
        });
      }

      const repaired = await maybeRepairCodexSessionRoutes({
        cfg,
        env: state.env,
        shouldRepair: true,
      });

      expect(repaired.repairedSessions).toBe(1);
      expect(loadSessionEntry({ ...scope, sessionKey })).toMatchObject({
        modelProvider: "openai",
        model: "current-model",
        cliSessionBindings: bindings,
      });
      expect(fs.readFileSync(storePath)).toEqual(source);
      expect(readDeferredPluginSessionImport(receiptParams)).toEqual(receipt);
    },
  );

  it("repairs a legacy route without inventing a harness", async () => {
    const { scope, repair } = await seedRuntimeSession("retired-runtime", {
      modelProvider: "openai-codex",
      model: "current-model",
      agentRuntimeOverride: "codex-cli",
    });
    expect((await repair()).repairedSessions).toBe(1);
    const entry = loadSessionEntry(scope);
    expect(entry).toMatchObject({
      modelProvider: "openai",
      model: "current-model",
      agentRuntimeOverride: "codex",
      ...accountPin,
      cliSessionBindings: bindings,
    });
    expect(entry?.agentHarnessId).toBeUndefined();
    await expectStableRepair(scope, repair);
  });

  it("repairs the legacy pair while preserving account pins", async () => {
    const { scope, repair } = await seedRuntimeSession("legacy-pair", {
      modelProvider: "claude-cli",
      model: "assistant-a",
      providerOverride: "claude-cli",
      modelOverride: "assistant-a",
      modelOverrideSource: "user",
      agentRuntimeOverride: undefined,
    });
    expect((await repair()).repairedSessions).toBe(1);
    expect(loadSessionEntry(scope)).toMatchObject({
      modelProvider: "anthropic",
      model: "assistant-a",
      providerOverride: "anthropic",
      modelOverride: "assistant-a",
      modelOverrideSource: "user",
      ...accountPin,
      agentRuntimeOverride: "claude-cli",
      cliSessionBindings: bindings,
    });
    await expectStableRepair(scope, repair);
  });
});
