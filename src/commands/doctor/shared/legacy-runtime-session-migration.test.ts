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

  it.each([
    ["retired-runtime", "openai-codex", "openai", "codex", "current-model"],
    ["legacy-pair", "claude-cli", "anthropic", "claude-cli", "assistant-a"],
  ] as const)(
    "repairs %s without losing account pins or inventing a harness",
    async (sessionId, provider, canonical, runtime, model) => {
      const state = await createState("runtime-route-");
      const scope = {
        storePath: path.join(state.sessionsDir(), "sessions.json"),
        sessionKey: "agent:main:" + sessionId,
        env: state.env,
      };
      const paired = sessionId === "legacy-pair";
      const overrides = paired
        ? { providerOverride: provider, modelOverride: model, modelOverrideSource: "user" as const }
        : {};
      await replaceSessionEntry(scope, {
        sessionId,
        updatedAt: 1,
        ...accountPin,
        claudeCliSessionId: "retained-binding",
        ...overrides,
        modelProvider: provider,
        model,
        agentRuntimeOverride: paired ? undefined : "codex-cli",
      });
      const repair = (shouldRepair: boolean) =>
        maybeRepairCodexSessionRoutes({ cfg: runtimeConfig, env: state.env, shouldRepair });
      const before = loadSessionEntry(scope);
      await repair(false);
      expect(loadSessionEntry(scope)).toEqual(before);
      expect((await repair(true)).repairedSessions).toBe(1);
      const entry = loadSessionEntry(scope);
      expect(entry).toMatchObject({
        ...overrides,
        ...(paired ? { providerOverride: canonical } : {}),
        ...accountPin,
        modelProvider: canonical,
        model,
        agentRuntimeOverride: runtime,
        cliSessionBindings: bindings,
      });
      expect(entry).not.toHaveProperty("claudeCliSessionId");
      if (sessionId === "retired-runtime") {
        expect(entry?.agentHarnessId).toBeUndefined();
      }
      expect((await repair(true)).repairedSessions).toBe(0);
      expect(loadSessionEntry(scope)).toEqual(entry);
    },
  );
});
