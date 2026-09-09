import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { maybeRepairCodexSessionRoutes } from "./codex-route-session-repair.js";

const states: OpenClawTestState[] = [];
afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  for (const state of states.splice(0)) {
    await state.cleanup();
  }
});

describe("legacy runtime session model migration", () => {
  it.each([
    { runtime: "codex-cli", expectedRuntime: "codex" },
    { runtime: "openclaw", expectedRuntime: "openclaw" },
  ])("repairs a legacy route without inventing a harness for $runtime", async (row) => {
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
      agentRuntimeOverride: row.runtime,
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
      agentRuntimeOverride: row.expectedRuntime,
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

  it.each([
    {
      overrideProvider: "google-gemini-cli",
      overrideModel: "assistant-b",
      expectedProvider: "google",
      explicitRuntime: undefined,
      expectedRuntime: "google-gemini-cli",
    },
    {
      overrideProvider: "google-gemini-cli",
      overrideModel: "assistant-b",
      expectedProvider: "google",
      explicitRuntime: "openclaw",
      expectedRuntime: "openclaw",
    },
    {
      overrideProvider: "openai",
      overrideModel: "claude-cli/team/model",
      expectedProvider: "openai",
      explicitRuntime: undefined,
      expectedRuntime: undefined,
    },
  ])("uses the selected override runtime while retaining $explicitRuntime", async (row) => {
    const state = await createOpenClawTestState({ layout: "state-only", prefix: "runtime-order-" });
    states.push(state);
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      agents: { entries: { main: {} }, defaults: { model: "openai/current-model" } },
    };
    const scope = {
      storePath: path.join(state.sessionsDir(), "sessions.json"),
      sessionKey: "agent:main:mixed-runtimes",
      env: state.env,
    };
    await replaceSessionEntry(scope, {
      sessionId: "mixed-runtimes",
      updatedAt: 1,
      modelProvider: "claude-cli",
      model: "assistant-a",
      providerOverride: row.overrideProvider,
      modelOverride: row.overrideModel,
      modelOverrideSource: "user",
      authProfileOverride: "authored:account",
      agentRuntimeOverride: row.explicitRuntime,
    });

    await maybeRepairCodexSessionRoutes({ cfg, env: state.env, shouldRepair: true });

    const entry = loadSessionEntry(scope);
    expect(entry).toMatchObject({
      modelProvider: "anthropic",
      model: "assistant-a",
      providerOverride: row.expectedProvider,
      modelOverride: row.overrideModel,
      authProfileOverride: "authored:account",
    });
    expect(entry?.agentRuntimeOverride).toBe(row.expectedRuntime);
  });

  it("updates the retired Codex runtime IDs without moving its account or binding", async () => {
    const state = await createOpenClawTestState({ layout: "state-only", prefix: "runtime-pair-" });
    states.push(state);
    state.applyEnv();
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      agents: { entries: { main: {} }, defaults: { model: "openai/current-model" } },
    };
    const scope = {
      storePath: path.join(state.sessionsDir(), "sessions.json"),
      sessionKey: "agent:main:legacy-runtime",
      env: state.env,
    };
    await replaceSessionEntry(scope, {
      sessionId: "legacy-runtime",
      updatedAt: 1,
      modelProvider: "openai",
      model: "current-model",
      agentHarnessId: "codex-cli",
      agentRuntimeOverride: "codex-cli",
      authProfileOverride: "authored:account",
      claudeCliSessionId: "retained-binding",
    });

    await maybeRepairCodexSessionRoutes({ cfg, env: state.env, shouldRepair: true });

    expect(loadSessionEntry(scope)).toMatchObject({
      modelProvider: "openai",
      model: "current-model",
      agentHarnessId: "codex",
      agentRuntimeOverride: "codex",
      authProfileOverride: "authored:account",
      cliSessionBindings: { "claude-cli": { sessionId: "retained-binding" } },
    });
    expect(loadSessionEntry(scope)).not.toHaveProperty("claudeCliSessionId");
  });

  it.each([
    { provider: "openai", model: "codex/team/custom-model" },
    { provider: "google", model: "claude-cli/team/model" },
    { provider: "anthropic", model: "google-gemini-cli/team/model" },
    { provider: "google", model: "google-gemini-cli/assistant-b" },
    { provider: "anthropic", model: "claude-cli/assistant-a" },
  ])("preserves a namespaced $model under explicit $provider", async ({ provider, model }) => {
    const state = await createOpenClawTestState({ layout: "state-only", prefix: "runtime-pair-" });
    states.push(state);
    state.applyEnv();
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      agents: { entries: { main: {} }, defaults: { model: "openai/current-model" } },
    };
    const scope = {
      storePath: path.join(state.sessionsDir(), "sessions.json"),
      sessionKey: "agent:main:custom-pair",
      env: state.env,
    };
    await replaceSessionEntry(scope, {
      sessionId: "custom-pair",
      updatedAt: 1,
      modelProvider: provider,
      model,
      providerOverride: provider,
      modelOverride: model,
      modelOverrideSource: "user",
      authProfileOverride: "authored:account",
      authProfileOverrideSource: "user",
    });
    const before = loadSessionEntry(scope);

    expect(
      (await maybeRepairCodexSessionRoutes({ cfg, env: state.env, shouldRepair: true }))
        .repairedSessions,
    ).toBe(0);
    expect(loadSessionEntry(scope)).toEqual(before);
    expect(
      (await maybeRepairCodexSessionRoutes({ cfg, env: state.env, shouldRepair: true }))
        .repairedSessions,
    ).toBe(0);
    expect(loadSessionEntry(scope)).toEqual(before);
  });

  it.each([
    {
      provider: "claude-cli",
      model: "assistant-a",
      canonicalProvider: "anthropic",
      canonicalModel: "assistant-a",
      explicitRuntime: undefined,
      expectedRuntime: "claude-cli",
    },
    {
      provider: "google-gemini-cli",
      model: "assistant-b",
      canonicalProvider: "google",
      canonicalModel: "assistant-b",
      explicitRuntime: "openclaw",
      expectedRuntime: "openclaw",
    },
  ])(
    "repairs the $provider pair while preserving explicit runtime and account pins",
    async (row) => {
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
        modelProvider: row.provider,
        model: row.model,
        providerOverride: row.provider,
        modelOverride: row.model,
        modelOverrideSource: "user",
        authProfileOverride: "authored:account",
        authProfileOverrideSource: "user",
        agentRuntimeOverride: row.explicitRuntime,
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
        modelProvider: row.canonicalProvider,
        model: row.canonicalModel,
        providerOverride: row.canonicalProvider,
        modelOverride: row.canonicalModel,
        modelOverrideSource: "user",
        authProfileOverride: "authored:account",
        authProfileOverrideSource: "user",
        agentRuntimeOverride: row.expectedRuntime,
        cliSessionBindings: { "claude-cli": { sessionId: "retained-binding" } },
      });
      expect(loadSessionEntry(scope)).not.toHaveProperty("claudeCliSessionId");
      expect(
        (await maybeRepairCodexSessionRoutes({ cfg, env: state.env, shouldRepair: true }))
          .repairedSessions,
      ).toBe(0);
    },
  );
});
