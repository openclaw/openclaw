import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getCliSessionBinding, resolveCliSessionReuse } from "../../../agents/cli-session.js";
import {
  loadSessionEntry,
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../../config/sessions/session-sqlite-target.js";
import type { CliSessionBinding, SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { recordDeferredPluginMigrations } from "../../../infra/deferred-plugin-migrations.js";
import { readDeferredPluginSessionImport } from "../../../infra/deferred-plugin-session-sources.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import { seedDeferredPluginSessionSource } from "../../doctor-session-sqlite.deferred-plugin.test-support.js";
import { runDoctorSessionSqlite } from "../../doctor-session-sqlite.js";
import { maybeRepairCodexSessionRoutes } from "./codex-route-session-repair.js";

const states: OpenClawTestState[] = [];
function session(sessionId: string, fields: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId, updatedAt: 1, ...fields };
}
async function fixture(
  cfg: OpenClawConfig = { plugins: { enabled: false } },
  layout: "home" | "state-only" = "home",
) {
  const state = await createOpenClawTestState({ layout, prefix: "legacy-cli-binding-" });
  states.push(state);
  if (layout === "state-only") {
    state.applyEnv();
  }
  const scope = (key: string) => ({
    storePath: path.join(state.sessionsDir(), "sessions.json"),
    sessionKey: `agent:main:${key}`,
    env: state.env,
  });
  return {
    state,
    read: (key: string) => loadSessionEntryReadOnly(scope(key)),
    readImported: (key: string) => loadSessionEntry(scope(key)),
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

describe("legacy runtime session model migration", () => {
  const runtimeConfig: OpenClawConfig = {
    plugins: { enabled: false },
    agents: { entries: { main: {} }, defaults: { model: "openai/current-model" } },
  };
  const accountPin = {
    authProfileOverride: "authored:account",
    authProfileOverrideSource: "user" as const,
  };
  const bindings = { "claude-cli": { sessionId: "retained-binding" } };

  it.each([false, true])(
    "repairs canonical routes without rewriting a receipted index (plugin completed: %s)",
    async (pluginCompleted) => {
      const { state } = await fixture(runtimeConfig, "state-only");
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
      expect(repaired.changes[0]).toContain("in 1 session across ");
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
      const { readImported: read, write, repair } = await fixture(runtimeConfig, "state-only");
      const paired = sessionId === "legacy-pair";
      const overrides = paired
        ? { providerOverride: provider, modelOverride: model, modelOverrideSource: "user" as const }
        : {};
      await write(sessionId, {
        sessionId,
        updatedAt: 1,
        ...accountPin,
        claudeCliSessionId: "retained-binding",
        ...overrides,
        modelProvider: provider,
        model,
        agentRuntimeOverride: paired ? undefined : "codex-cli",
      });
      const before = read(sessionId);
      await repair(false);
      expect(read(sessionId)).toEqual(before);
      expect((await repair()).changes[0]).toContain("in 1 session across ");
      const entry = read(sessionId);
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
      expect((await repair()).changes).toEqual([]);
      expect(read(sessionId)).toEqual(entry);
    },
  );
});

describe("legacy CLI session binding migration", () => {
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
    const sessionIds = { "claude-cli": "Map-Conversation", "other-cli": "Other-Map-ID" };
    await write(
      "canonical",
      session("canonical-local", {
        claudeCliSessionId: "Obsolete-Conversation",
        cliSessionIds: { "claude-cli": "Map-Conversation" },
        cliSessionBindings: { "claude-cli": canonical, "other-cli": { sessionId: "Other-ID" } },
      }),
    );
    await write(
      "map",
      session("map-local", {
        claudeCliSessionId: "Obsolete-Map-Conversation",
        cliSessionIds: sessionIds,
      }),
    );

    const repaired = await repair();
    expect(repaired.changes[0]).toContain("in 2 sessions across ");
    await reopen();
    const savedCanonical = read("canonical");
    const savedMap = read("map");
    expect(savedCanonical?.cliSessionBindings).toEqual({
      "claude-cli": canonical,
      "other-cli": { sessionId: "Other-ID" },
    });
    expect(savedMap?.cliSessionIds).toEqual(sessionIds);
    expect(getCliSessionBinding(savedMap, "claude-cli")).toEqual({ sessionId: "Map-Conversation" });
    expect(savedCanonical).not.toHaveProperty("claudeCliSessionId");
    expect(savedMap).not.toHaveProperty("claudeCliSessionId");
  });

  it("migrates safe rows while preserving unresolved bindings and locked ownership", async () => {
    const { read, write, repair, reopen } = await fixture();
    const malformed = session("malformed-local");
    Object.assign(malformed, { claudeCliSessionId: 17 });
    const rows: Record<string, SessionEntry> = {
      safe: session("safe-local", {
        claudeCliSessionId: "  Safe-MixedCase/ID  ",
        cliSessionBindings: { "claude-cli": { sessionId: " " } },
      }),
      ambiguous: session("ambiguous-local", {
        claudeCliSessionId: "Old-Conversation",
        cliSessionBindings: { "claude-cli": { sessionId: " ", authEpoch: "Unbound-Epoch" } },
      }),
      empty: session("empty-local", { claudeCliSessionId: " " }),
      malformed,
      locked: session("locked-local", {
        agentHarnessId: "claude-cli",
        modelSelectionLocked: true,
        modelProvider: "claude-cli",
        model: "retained-model",
        claudeCliSessionId: "Locked-Conversation",
      }),
    };
    for (const [key, entry] of Object.entries(rows)) {
      await write(key, entry);
    }
    const before = Object.fromEntries(Object.keys(rows).map((key) => [key, read(key)]));
    const preview = await repair(false);
    expect(preview.warnings.join("\n")).toContain("manual reconciliation");
    expect(read("safe")).toEqual(before.safe);

    const repaired = await repair();
    expect(repaired.changes[0]).toContain("in 2 sessions across ");
    for (const key of ["ambiguous", "empty", "malformed"]) {
      expect(repaired.warnings.join("\n")).toContain(`agent:main:${key}`);
    }
    await reopen();
    const safe = read("safe");
    expect(safe?.cliSessionBindings?.["claude-cli"]).toEqual({ sessionId: "Safe-MixedCase/ID" });
    expect(reuse(safe)).toEqual({ mode: "reuse", sessionId: "Safe-MixedCase/ID" });
    expect(safe?.sessionId).toBe("safe-local");
    expect(safe).not.toHaveProperty("claudeCliSessionId");
    const locked = read("locked");
    const { claudeCliSessionId: _legacyBinding, ...preserved } = rows.locked!;
    expect(locked).toMatchObject(preserved);
    expect(locked).not.toHaveProperty("claudeCliSessionId");
    expect(reuse(locked)).toEqual({ mode: "reuse", sessionId: "Locked-Conversation" });
    for (const key of ["ambiguous", "empty", "malformed"]) {
      expect(read(key)).toEqual(before[key]);
    }
    const repeated = await repair();
    expect(repeated.changes).toEqual([]);
    expect(repeated.warnings).toEqual(repaired.warnings);
  });
});
