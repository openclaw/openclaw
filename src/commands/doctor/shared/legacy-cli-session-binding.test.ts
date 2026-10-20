import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getCliSessionBinding, resolveCliSessionReuse } from "../../../agents/cli-session.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { CliSessionBinding, SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import { maybeRepairCodexSessionRoutes } from "./codex-route-session-repair.js";

const states: OpenClawTestState[] = [];
async function fixture(cfg: OpenClawConfig = { plugins: { enabled: false } }) {
  const state = await createOpenClawTestState({ layout: "home", prefix: "legacy-cli-binding-" });
  states.push(state);
  const scope = (key: string) => ({
    storePath: path.join(state.sessionsDir(), "sessions.json"),
    sessionKey: `agent:main:${key}`,
    env: state.env,
  });
  return {
    read: (key: string) => loadSessionEntryReadOnly(scope(key)),
    write: (key: string, entry: SessionEntry) => replaceSessionEntry(scope(key), entry),
    repair: (shouldRepair = true) =>
      maybeRepairCodexSessionRoutes({ cfg, env: state.env, shouldRepair }),
    reopen: () => cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root }),
  };
}
function reuse(entry: SessionEntry | undefined) {
  return resolveCliSessionReuse({
    binding: getCliSessionBinding(entry, " CLAUDE-CLI "),
    authEpochVersion: 4,
  });
}
afterEach(async () => {
  for (const state of states.splice(0)) {
    await state.cleanup();
  }
});

describe("legacy CLI session binding migration", () => {
  it("migrates a legacy-only session without changing resume selection", async () => {
    const { read, write, repair, reopen } = await fixture({
      plugins: { enabled: false },
      agents: { entries: { main: {} }, defaults: { model: "openai/current-model" } },
    });
    await write("legacy-binding", {
      sessionId: "local-binding-session",
      updatedAt: 1,
      claudeCliSessionId: "Remote-MixedCase-Session/Alpha",
    });
    const before = read("legacy-binding");

    await repair(false);
    expect(read("legacy-binding")).toEqual(before);
    await repair();

    const saved = read("legacy-binding");
    expect(saved?.cliSessionBindings?.["claude-cli"]).toEqual({
      sessionId: "Remote-MixedCase-Session/Alpha",
    });
    expect(saved).not.toHaveProperty("claudeCliSessionId");
    await reopen();
    const reopened = read("legacy-binding");
    expect(reuse(reopened)).toEqual({ mode: "reuse", sessionId: "Remote-MixedCase-Session/Alpha" });
    expect(reopened?.sessionId).toBe("local-binding-session");
    expect((await repair()).repairedSessions).toBe(0);
    expect(read("legacy-binding")).toEqual(reopened);
  });

  it("preserves canonical metadata and provider-map precedence across reopen", async () => {
    const { read, write, repair, reopen } = await fixture();
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
    await write("canonical", {
      sessionId: "canonical-local",
      updatedAt: 1,
      claudeCliSessionId: "Obsolete-Conversation",
      cliSessionIds: { "claude-cli": "Map-Conversation" },
      cliSessionBindings: { "claude-cli": canonical, "other-cli": { sessionId: "Other-ID" } },
    });
    await write("map", {
      sessionId: "map-local",
      updatedAt: 2,
      claudeCliSessionId: "Obsolete-Map-Conversation",
      cliSessionIds: { "claude-cli": "Map-Conversation", "other-cli": "Other-Map-ID" },
    });

    const repaired = await repair();
    expect(repaired.repairedSessions).toBe(2);
    await reopen();
    const savedCanonical = read("canonical");
    const savedMap = read("map");
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
    const { read, write, repair, reopen } = await fixture();
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
    for (const [key, entry] of Object.entries(rows)) {
      await write(key, entry);
    }
    const before = Object.fromEntries(Object.keys(rows).map((key) => [key, read(key)]));
    const preview = await repair(false);
    expect(preview.warnings.join("\n")).toContain("manual reconciliation");
    expect(read("safe")).toEqual(before.safe);

    const repaired = await repair();
    expect(repaired.repairedSessions).toBe(2);
    for (const key of ["ambiguous", "empty", "malformed"]) {
      expect(repaired.warnings.join("\n")).toContain(`agent:main:${key}`);
    }
    await reopen();
    expect(getCliSessionBinding(read("safe"), "claude-cli")?.sessionId).toBe("Safe-MixedCase/ID");
    expect(read("safe")).not.toHaveProperty("claudeCliSessionId");
    const locked = read("locked");
    expect(locked).toMatchObject({
      sessionId: "locked-local",
      updatedAt: 5,
      agentHarnessId: "claude-cli",
      modelSelectionLocked: true,
      modelProvider: "claude-cli",
      model: "retained-model",
    });
    expect(locked).not.toHaveProperty("claudeCliSessionId");
    expect(reuse(locked)).toEqual({ mode: "reuse", sessionId: "Locked-Conversation" });
    for (const key of ["ambiguous", "empty", "malformed"]) {
      expect(read(key)).toEqual(before[key]);
    }
    const repeated = await repair();
    expect(repeated.repairedSessions).toBe(0);
    expect(repeated.warnings).toEqual(repaired.warnings);
  });
});
