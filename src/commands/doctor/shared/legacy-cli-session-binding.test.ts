import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getCliSessionBinding, resolveCliSessionReuse } from "../../../agents/cli-session.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { CliSessionBinding, SessionEntry } from "../../../config/sessions/types.js";
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

describe("legacy CLI session binding migration", () => {
  it("migrates a legacy-only session without changing resume selection", async () => {
    const state = await createOpenClawTestState({
      layout: "home",
      prefix: "legacy-cli-binding-",
    });
    states.push(state);
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      agents: { entries: { main: {} }, defaults: { model: "openai/current-model" } },
    };
    const scope = {
      storePath: path.join(state.sessionsDir(), "sessions.json"),
      sessionKey: "agent:main:legacy-binding",
      env: state.env,
    };
    await replaceSessionEntry(scope, {
      sessionId: "local-binding-session",
      updatedAt: 1,
      claudeCliSessionId: "Remote-MixedCase-Session/Alpha",
    });
    const before = loadSessionEntryReadOnly(scope);

    await maybeRepairCodexSessionRoutes({ cfg, env: state.env, shouldRepair: false });
    expect(loadSessionEntryReadOnly(scope)).toEqual(before);
    await maybeRepairCodexSessionRoutes({ cfg, env: state.env, shouldRepair: true });

    const saved = loadSessionEntryReadOnly(scope);
    expect(saved?.cliSessionBindings?.["claude-cli"]).toEqual({
      sessionId: "Remote-MixedCase-Session/Alpha",
    });
    expect(saved).not.toHaveProperty("claudeCliSessionId");
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    const reopened = loadSessionEntryReadOnly(scope);
    expect(
      resolveCliSessionReuse({
        binding: getCliSessionBinding(reopened, " CLAUDE-CLI "),
        authEpochVersion: 4,
      }),
    ).toEqual({ mode: "reuse", sessionId: "Remote-MixedCase-Session/Alpha" });
    expect(reopened?.sessionId).toBe("local-binding-session");
    expect(
      (await maybeRepairCodexSessionRoutes({ cfg, env: state.env, shouldRepair: true }))
        .repairedSessions,
    ).toBe(0);
    expect(loadSessionEntryReadOnly(scope)).toEqual(reopened);
  });

  it("preserves canonical metadata and provider-map precedence across reopen", async () => {
    const state = await createOpenClawTestState({ layout: "home", prefix: "binding-precedence-" });
    states.push(state);
    const cfg: OpenClawConfig = { plugins: { enabled: false } };
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const canonical: CliSessionBinding = {
      sessionId: "Canonical-Conversation",
      resumeCheckpointId: "Checkpoint-A",
      forceReuse: true,
      forkNextResume: true,
      authProfileId: "anthropic:work",
      authEpoch: "Epoch-A",
      authEpochVersion: 4,
      extraSystemPromptHash: "prompt-a",
      messageToolPolicyHash: "policy-a",
      promptToolNamesHash: "tools-a",
      cwdHash: "cwd-a",
      mcpConfigHash: "mcp-a",
      mcpResumeHash: "resume-a",
      reseedReceipt: {
        version: 1,
        promptHash: "a".repeat(64),
        localSessionId: "canonical-local",
        userTurnDisposition: "omitted",
      },
    };
    const canonicalScope = { storePath, env: state.env, sessionKey: "agent:main:canonical" };
    const mapScope = { storePath, env: state.env, sessionKey: "agent:main:map" };
    await replaceSessionEntry(canonicalScope, {
      sessionId: "canonical-local",
      updatedAt: 1,
      claudeCliSessionId: "Obsolete-Conversation",
      cliSessionIds: { "claude-cli": "Map-Conversation" },
      cliSessionBindings: { "claude-cli": canonical, "other-cli": { sessionId: "Other-ID" } },
    });
    await replaceSessionEntry(mapScope, {
      sessionId: "map-local",
      updatedAt: 2,
      claudeCliSessionId: "Obsolete-Map-Conversation",
      cliSessionIds: { "claude-cli": "Map-Conversation", "other-cli": "Other-Map-ID" },
    });

    const repaired = await maybeRepairCodexSessionRoutes({
      cfg,
      env: state.env,
      shouldRepair: true,
    });
    expect(repaired.repairedSessions).toBe(2);
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    const savedCanonical = loadSessionEntryReadOnly(canonicalScope);
    const savedMap = loadSessionEntryReadOnly(mapScope);
    expect(savedCanonical?.cliSessionBindings).toEqual({
      "claude-cli": canonical,
      "other-cli": { sessionId: "Other-ID" },
    });
    expect(getCliSessionBinding(savedCanonical, "claude-cli")).toEqual(canonical);
    expect(savedMap?.cliSessionIds).toEqual({
      "claude-cli": "Map-Conversation",
      "other-cli": "Other-Map-ID",
    });
    expect(getCliSessionBinding(savedMap, "claude-cli")).toEqual({ sessionId: "Map-Conversation" });
    expect(savedCanonical).not.toHaveProperty("claudeCliSessionId");
    expect(savedMap).not.toHaveProperty("claudeCliSessionId");
  });

  it("migrates safe rows while preserving unresolved bindings and locked ownership", async () => {
    const state = await createOpenClawTestState({ layout: "home", prefix: "binding-mixed-" });
    states.push(state);
    const cfg: OpenClawConfig = { plugins: { enabled: false } };
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const malformed: SessionEntry = { sessionId: "malformed-local", updatedAt: 4 };
    Object.assign(malformed, { claudeCliSessionId: 17 });
    const rows: Record<string, SessionEntry> = {
      safe: {
        sessionId: "safe-local",
        updatedAt: 1,
        claudeCliSessionId: "  Safe-MixedCase/ID  ",
        cliSessionBindings: { "claude-cli": { sessionId: " " } },
      },
      ambiguous: {
        sessionId: "ambiguous-local",
        updatedAt: 2,
        claudeCliSessionId: "Old-Conversation",
        cliSessionBindings: { "claude-cli": { sessionId: " ", authEpoch: "Unbound-Epoch" } },
      },
      empty: { sessionId: "empty-local", updatedAt: 3, claudeCliSessionId: " " },
      malformed,
      locked: {
        sessionId: "locked-local",
        updatedAt: 5,
        agentHarnessId: "claude-cli",
        modelSelectionLocked: true,
        modelProvider: "claude-cli",
        model: "retained-model",
        claudeCliSessionId: "Locked-Conversation",
      },
    };
    const scope = (key: string) => ({ storePath, env: state.env, sessionKey: `agent:main:${key}` });
    for (const [key, entry] of Object.entries(rows)) {
      await replaceSessionEntry(scope(key), entry);
    }
    const before = Object.fromEntries(
      Object.keys(rows).map((key) => [key, loadSessionEntryReadOnly(scope(key))]),
    );
    const preview = await maybeRepairCodexSessionRoutes({
      cfg,
      env: state.env,
      shouldRepair: false,
    });
    expect(preview.warnings.join("\n")).toContain("manual reconciliation");
    expect(loadSessionEntryReadOnly(scope("safe"))).toEqual(before.safe);

    const repair = await maybeRepairCodexSessionRoutes({ cfg, env: state.env, shouldRepair: true });
    expect(repair.repairedSessions).toBe(2);
    expect(repair.warnings.join("\n")).toContain("agent:main:ambiguous");
    expect(repair.warnings.join("\n")).toContain("agent:main:empty");
    expect(repair.warnings.join("\n")).toContain("agent:main:malformed");
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    expect(
      getCliSessionBinding(loadSessionEntryReadOnly(scope("safe")), "claude-cli")?.sessionId,
    ).toBe("Safe-MixedCase/ID");
    expect(loadSessionEntryReadOnly(scope("safe"))).not.toHaveProperty("claudeCliSessionId");
    const locked = loadSessionEntryReadOnly(scope("locked"));
    expect(locked).toMatchObject({
      sessionId: "locked-local",
      updatedAt: 5,
      agentHarnessId: "claude-cli",
      modelSelectionLocked: true,
      modelProvider: "claude-cli",
      model: "retained-model",
    });
    expect(locked).not.toHaveProperty("claudeCliSessionId");
    expect(
      resolveCliSessionReuse({
        binding: getCliSessionBinding(locked, "claude-cli"),
        authEpochVersion: 4,
      }),
    ).toEqual({ mode: "reuse", sessionId: "Locked-Conversation" });
    for (const key of ["ambiguous", "empty", "malformed"]) {
      expect(loadSessionEntryReadOnly(scope(key))).toEqual(before[key]);
    }
    const repeated = await maybeRepairCodexSessionRoutes({
      cfg,
      env: state.env,
      shouldRepair: true,
    });
    expect(repeated.repairedSessions).toBe(0);
    expect(repeated.warnings).toEqual(repair.warnings);
  });
});
