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
afterEach(async () => {
  for (const state of states.splice(0)) {
    await state.cleanup();
  }
});

describe("legacy runtime session model migration", () => {
  it.each([false, true])(
    "repairs canonical routes without rewriting a receipted index (plugin completed: %s)",
    async (pluginCompleted) => {
      const state = await createOpenClawTestState({
        layout: "state-only",
        prefix: "retained-route-",
      });
      states.push(state);
      state.applyEnv();
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
        cliSessionBindings: { "claude-cli": { sessionId: "retained-binding" } },
      });
      expect(fs.readFileSync(storePath)).toEqual(source);
      expect(readDeferredPluginSessionImport(receiptParams)).toEqual(receipt);
    },
  );

  it("repairs a legacy route without inventing a harness", async () => {
    const state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "runtime-no-harness-",
    });
    states.push(state);
    state.applyEnv();
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      agents: { entries: { main: {} }, defaults: { model: "openai/current-model" } },
    };
    const scope = {
      storePath: path.join(state.sessionsDir(), "sessions.json"),
      sessionKey: "agent:main:retired-runtime",
      env: state.env,
    };
    await replaceSessionEntry(scope, {
      sessionId: "retired-runtime",
      updatedAt: 1,
      modelProvider: "openai-codex",
      model: "current-model",
      agentRuntimeOverride: "codex-cli",
      authProfileOverride: "authored:account",
      authProfileOverrideSource: "user",
      claudeCliSessionId: "retained-binding",
    });
    const before = loadSessionEntry(scope);
    await maybeRepairCodexSessionRoutes({ cfg, env: state.env, shouldRepair: false });
    expect(loadSessionEntry(scope)).toEqual(before);

    const repaired = await maybeRepairCodexSessionRoutes({
      cfg,
      env: state.env,
      shouldRepair: true,
    });

    expect(repaired.repairedSessions).toBe(1);
    const entry = loadSessionEntry(scope);
    expect(entry).toMatchObject({
      modelProvider: "openai",
      model: "current-model",
      agentRuntimeOverride: "codex",
      authProfileOverride: "authored:account",
      authProfileOverrideSource: "user",
      cliSessionBindings: { "claude-cli": { sessionId: "retained-binding" } },
    });
    expect(entry).not.toHaveProperty("claudeCliSessionId");
    expect(entry?.agentHarnessId).toBeUndefined();
    expect(
      (await maybeRepairCodexSessionRoutes({ cfg, env: state.env, shouldRepair: true }))
        .repairedSessions,
    ).toBe(0);
    expect(loadSessionEntry(scope)).toEqual(entry);
  });

  it("repairs the legacy pair while preserving account pins", async () => {
    const state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "runtime-pair-",
    });
    states.push(state);
    state.applyEnv();
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      agents: { entries: { main: {} }, defaults: { model: "openai/current-model" } },
    };
    const scope = {
      storePath: path.join(state.sessionsDir(), "sessions.json"),
      sessionKey: "agent:main:legacy-pair",
      env: state.env,
    };
    await replaceSessionEntry(scope, {
      sessionId: "legacy-pair",
      updatedAt: 1,
      modelProvider: "claude-cli",
      model: "assistant-a",
      providerOverride: "claude-cli",
      modelOverride: "assistant-a",
      modelOverrideSource: "user",
      authProfileOverride: "authored:account",
      authProfileOverrideSource: "user",
      agentRuntimeOverride: undefined,
      claudeCliSessionId: "retained-binding",
    });
    const before = loadSessionEntry(scope);
    await maybeRepairCodexSessionRoutes({ cfg, env: state.env, shouldRepair: false });
    expect(loadSessionEntry(scope)).toEqual(before);

    const result = await maybeRepairCodexSessionRoutes({
      cfg,
      env: state.env,
      shouldRepair: true,
    });

    expect(result.repairedSessions).toBe(1);
    expect(loadSessionEntry(scope)).toMatchObject({
      modelProvider: "anthropic",
      model: "assistant-a",
      providerOverride: "anthropic",
      modelOverride: "assistant-a",
      modelOverrideSource: "user",
      authProfileOverride: "authored:account",
      authProfileOverrideSource: "user",
      agentRuntimeOverride: "claude-cli",
      cliSessionBindings: { "claude-cli": { sessionId: "retained-binding" } },
    });
    expect(loadSessionEntry(scope)).not.toHaveProperty("claudeCliSessionId");
    expect(
      (await maybeRepairCodexSessionRoutes({ cfg, env: state.env, shouldRepair: true }))
        .repairedSessions,
    ).toBe(0);
  });
});
