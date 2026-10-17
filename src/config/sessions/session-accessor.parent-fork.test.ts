import fs from "node:fs/promises";
import path from "node:path";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { parseSqliteSessionFileMarker } from "./legacy-sqlite-marker.js";
import {
  forkSessionEntryFromParentTarget,
  forkSessionFromParentTranscript,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import { resolveSqliteStoreScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { withTranscriptWriteSequence } from "./session-accessor.sqlite-transcript-write.js";

const forkableClaudeCliBackend = {
  id: "claude-cli",
  pluginId: "anthropic",
  modelProvider: "anthropic",
  config: { command: "claude", forkArg: "--fork-session", resumeAtArg: "--resume-session-at" },
  bundleMcp: false,
  ownsNativeCompaction: false,
} satisfies ReturnType<
  (typeof import("../../plugins/cli-backends.runtime.js"))["resolveRuntimeCliBackends"]
>[number];

afterEach(() => cliBackendsTesting.resetDepsForTest());

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-parent-fork-");

async function createStore() {
  const root = sessionDirs.make();
  const sessionsDir = path.join(root, "sessions");
  await fs.mkdir(sessionsDir);
  return { root, storePath: path.join(sessionsDir, "sessions.json") };
}

const header = (id: string, cwd: string, timestamp = "2026-06-15T00:00:00.000Z") => ({
  type: "session",
  version: 3,
  id,
  timestamp,
  cwd,
});
const event = (type: string, id: string, fields: Record<string, unknown>) => ({
  type,
  id,
  ...fields,
});
const childEvents = async (storePath: string, sessionId: string) =>
  (await loadTranscriptEvents({
    agentId: "main",
    sessionId,
    sessionKey: "agent:main:child",
    storePath,
  })) as Record<string, unknown>[];

async function seedParentTranscript(params: {
  storePath: string;
  parentSessionId: string;
  events: Record<string, unknown>[];
}): Promise<void> {
  await withTranscriptWriteSequence(
    {
      agentId: "main",
      sessionId: params.parentSessionId,
      sessionKey: "agent:main:main",
      storePath: params.storePath,
    },
    (transcript) => transcript.replaceEvents(params.events),
  );
}

async function forkChildTranscript(
  storePath: string,
  parentSessionId: string,
  targetStorePath?: string,
) {
  const forked = await forkSessionFromParentTranscript({
    parentEntry: { sessionId: parentSessionId, updatedAt: Date.now() },
    agentId: "main",
    parentSessionKey: "agent:main:main",
    sessionKey: "agent:main:child",
    storePath,
    targetStorePath,
  });
  if (forked.status !== "created") {
    throw new Error("expected forked session");
  }
  return forked.transcript;
}

// Forking writes transcript rows; opening the child also needs its logical entry.
async function openForkedChildSession(
  storePath: string,
  fork: { sessionId: string; sessionFile: string },
): Promise<SessionManager> {
  await replaceSessionEntry(
    { sessionKey: "agent:main:child", storePath },
    { sessionId: fork.sessionId, sessionFile: fork.sessionFile, updatedAt: Date.now() },
  );
  return SessionManager.openAsync({
    agentId: "main",
    sessionId: fork.sessionId,
    sessionKey: "agent:main:child",
    storePath,
  });
}

describe("forkSessionFromParentTranscript", () => {
  it("checks authority inside same- and cross-database transcript commits", async () => {
    const root = sessionDirs.make();
    const storePath = path.join(root, "sessions.json");
    const parentSessionId = "parent-guarded";
    await seedParentTranscript({
      storePath,
      parentSessionId,
      events: [
        header(parentSessionId, root, "2026-08-18T00:00:00.000Z"),
        event("message", "private-message", {
          parentId: null,
          timestamp: "2026-08-18T00:00:01.000Z",
          message: { role: "user", content: "private context" },
        }),
      ],
    });

    for (const target of [
      {
        agentId: "main",
        sessionId: "same-database-child",
        sessionKey: "agent:main:guarded-child",
        targetStorePath: undefined,
      },
      {
        agentId: "work",
        sessionId: "cross-database-child",
        sessionKey: "agent:work:guarded-child",
        targetStorePath: path.join(root, "work-sessions.json"),
      },
    ]) {
      const commitGuard = () => {
        throw new Error("session participation changed");
      };
      await expect(
        forkSessionFromParentTranscript({
          agentId: "main",
          commitGuard,
          parentEntry: { sessionId: parentSessionId, updatedAt: 1 },
          parentSessionKey: "agent:main:main",
          sessionKey: target.sessionKey,
          storePath,
          targetSessionId: target.sessionId,
          ...(target.targetStorePath ? { targetStorePath: target.targetStorePath } : {}),
        }),
      ).rejects.toThrow("session participation changed");
      await expect(
        loadTranscriptEvents({
          agentId: target.agentId,
          sessionId: target.sessionId,
          sessionKey: target.sessionKey,
          storePath: target.targetStorePath ?? storePath,
        }),
      ).resolves.toEqual([]);
    }
  });

  it("forks the active branch across stores without caller-thread SQL", async () => {
    const { root, storePath } = await createStore();
    const targetStorePath = path.join(root, "target-sessions.json");
    const cwd = path.join(root, "workspace");
    await fs.mkdir(cwd);
    const parentSessionId = "parent-session";
    const lines: Record<string, unknown>[] = [
      {
        type: "session",
        version: 3,
        id: parentSessionId,
        timestamp: "2026-05-01T00:00:00.000Z",
        cwd,
      },
      event("message", "user-1", {
        parentId: null,
        timestamp: "2026-05-01T00:00:01.000Z",
        message: { role: "user", content: "hello" },
      }),
      event("message", "assistant-1", {
        parentId: "user-1",
        timestamp: "2026-05-01T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          api: "openai-responses",
          provider: "openai",
          model: "gpt-5.4",
          stopReason: "stop",
          timestamp: 2,
        },
      }),
      event("label", "label-1", {
        parentId: "assistant-1",
        timestamp: "2026-05-01T00:00:03.000Z",
        targetId: "user-1",
        label: "start",
      }),
      event("message", "delivery-side-branch", {
        parentId: "label-1",
        timestamp: "2026-05-01T00:00:04.000Z",
        message: { role: "assistant", content: "side delivery" },
      }),
      event("leaf", "active-leaf", {
        parentId: "delivery-side-branch",
        timestamp: "2026-05-01T00:00:05.000Z",
        targetId: "label-1",
      }),
    ];
    await seedParentTranscript({ storePath, parentSessionId, events: lines });

    const sql = observeHostDataSql();
    let fork;
    try {
      fork = await forkChildTranscript(storePath, parentSessionId, targetStorePath);
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
    expect(fork.sessionFile).toBe("agent:main:child");
    expect(fork.sessionId).not.toBe(parentSessionId);
    const forkedEntries = await childEvents(targetStorePath, fork.sessionId);
    const forkedHeader = forkedEntries[0];
    expect(forkedHeader).toMatchObject({ type: "session", version: 3, id: fork.sessionId, cwd });
    expect(
      parseSqliteSessionFileMarker(
        typeof forkedHeader?.parentSession === "string" ? forkedHeader.parentSession : undefined,
      ),
    ).toMatchObject({
      agentId: "main",
      sessionId: parentSessionId,
    });
    expect(forkedEntries.map((entry) => entry.type)).toEqual([
      "session",
      "message",
      "message",
      "label",
      "leaf",
    ]);
    const forkedLabel = forkedEntries.find((entry) => entry.type === "label");
    expect(forkedLabel).toMatchObject({ type: "label", targetId: "user-1", label: "start" });
    expect(forkedEntries.at(-1)).toMatchObject({
      type: "leaf",
      targetId: "label-1",
      appendParentId: "label-1",
    });
    expect(JSON.stringify(forkedEntries)).not.toContain("side delivery");
  });

  it("keeps opaque append-parent metadata on the active fork branch", async () => {
    const { root, storePath } = await createStore();
    const parentSessionId = "parent-opaque";
    const entries: Record<string, unknown>[] = [
      header(parentSessionId, root),
      event("message", "active-root", {
        parentId: null,
        timestamp: "2026-06-15T00:00:01.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "active root" }] },
      }),
      event("label", "active-label", {
        parentId: "active-root",
        timestamp: "2026-06-15T00:00:01.500Z",
        targetId: "active-root",
        label: "selected",
      }),
      event("message", "side-delivery", {
        parentId: "active-root",
        timestamp: "2026-06-15T00:00:02.000Z",
        message: { role: "assistant", content: "side delivery" },
      }),
      event("metadata", "plugin-metadata", {
        parentId: "side-delivery",
        payload: { source: "plugin" },
      }),
      event("leaf", "active-leaf", {
        parentId: "side-delivery",
        timestamp: "2026-06-15T00:00:03.000Z",
        targetId: "active-root",
        appendParentId: "plugin-metadata",
        appendMode: "side",
      }),
    ];
    await seedParentTranscript({ storePath, parentSessionId, events: entries });

    const fork = await forkChildTranscript(storePath, parentSessionId);
    const forkedRecords = await childEvents(storePath, fork.sessionId);
    const serialized = JSON.stringify(forkedRecords);
    expect(serialized).toContain('"id":"active-root"');
    expect(serialized).toContain('"id":"plugin-metadata"');
    expect(serialized).not.toContain("side delivery");
    expect(forkedRecords.find((entry) => entry.id === "plugin-metadata")).toMatchObject({
      parentId: "active-root",
    });
    expect(forkedRecords.find((entry) => entry.type === "label")).toMatchObject({
      targetId: "active-root",
      label: "selected",
    });
    expect(forkedRecords.at(-1)).toMatchObject({
      type: "leaf",
      targetId: "active-root",
      appendParentId: "plugin-metadata",
      appendMode: "side",
    });
    const reopened = await openForkedChildSession(storePath, fork);
    await reopened.appendMessageAsync({
      role: "user",
      content: "continued",
      timestamp: Date.now(),
    });
    const records = await childEvents(storePath, fork.sessionId);
    expect(records.at(-1)).toMatchObject({ type: "message", parentId: "plugin-metadata" });
    expect(records.at(-1)).not.toHaveProperty("appendMode");
    expect(reopened.buildSessionContext().messages).toMatchObject([
      { role: "assistant", content: [{ type: "text", text: "active root" }] },
      { role: "user", content: "continued" },
    ]);
  });

  it("keeps an explicit empty visible branch separate from its opaque append parent", async () => {
    const { root, storePath } = await createStore();
    await seedParentTranscript({
      storePath,
      parentSessionId: "parent-empty-opaque",
      events: [
        header("parent-empty-opaque", root),
        event("message", "inactive-root", {
          parentId: null,
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "user", content: "inactive history" },
        }),
        event("leaf", "empty-leaf", {
          parentId: "inactive-root",
          timestamp: "2026-06-15T00:00:02.000Z",
          targetId: null,
          appendParentId: null,
        }),
        event("metadata", "plugin-metadata", {
          parentId: "inactive-root",
          payload: { source: "plugin" },
        }),
      ],
    });

    const fork = await forkChildTranscript(storePath, "parent-empty-opaque");
    const reopened = await openForkedChildSession(storePath, fork);
    expect(reopened.buildSessionContext().messages).toEqual([]);
    const continuedId = await reopened.appendMessageAsync({
      role: "user",
      content: "continued",
      timestamp: Date.now(),
    });
    await reopened.appendMessageAsync({
      role: "assistant",
      content: "done",
      api: "responses",
      provider: "openai",
      model: "gpt-test",
      timestamp: Date.now(),
    } as unknown as AssistantMessage);
    const records = await childEvents(storePath, fork.sessionId);
    expect(records.some((record) => record.id === "inactive-root")).toBe(false);
    expect(records.find((record) => record.id === continuedId)).toMatchObject({
      type: "message",
      parentId: "plugin-metadata",
    });
  });

  it("keeps a reachable branch suffix when an older parent is missing", async () => {
    const { root, storePath } = await createStore();
    await seedParentTranscript({
      storePath,
      parentSessionId: "parent-missing-ancestor",
      events: [
        header("parent-missing-ancestor", root),
        event("message", "reachable-tail", {
          parentId: "missing-parent",
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "assistant", content: "reachable tail" },
        }),
      ],
    });

    const fork = await forkChildTranscript(storePath, "parent-missing-ancestor");
    const records = await childEvents(storePath, fork.sessionId);
    const serialized = JSON.stringify(records);
    expect(serialized).toContain("reachable tail");
    expect(serialized).not.toContain("missing-parent");
  });

  it("keeps visible history when the next append explicitly starts a root branch", async () => {
    const { root, storePath } = await createStore();
    await seedParentTranscript({
      storePath,
      parentSessionId: "parent-root-append",
      events: [
        header("parent-root-append", root),
        event("message", "visible-root", {
          parentId: null,
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "assistant", content: "visible history" },
        }),
        event("leaf", "root-append-control", {
          parentId: "inactive-tail",
          timestamp: "2026-06-15T00:00:02.000Z",
          targetId: "visible-root",
          appendParentId: null,
        }),
      ],
    });

    const fork = await forkChildTranscript(storePath, "parent-root-append");
    const reopened = await openForkedChildSession(storePath, fork);
    expect(reopened.buildSessionContext().messages).toHaveLength(1);
    await reopened.appendMessageAsync({ role: "user", content: "new root", timestamp: Date.now() });
    const records = await childEvents(storePath, fork.sessionId);
    expect(records.at(-1)).toMatchObject({ type: "message", parentId: null });
  });

  it("preserves supported current-version linear transcripts", async ({ onTestFailed }) => {
    let phase = "create-fixture";
    onTestFailed(() => console.error(JSON.stringify({ test: "parent-linear", phase })));
    const { root, storePath } = await createStore();
    phase = "seed-parent";
    await seedParentTranscript({
      storePath,
      parentSessionId: "parent-linear",
      events: [
        header("parent-linear", root),
        event("message", "linear-user", {
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "user", content: "hello" },
        }),
        event("message", "linear-assistant", {
          timestamp: "2026-06-15T00:00:02.000Z",
          message: { role: "assistant", content: "hi" },
        }),
        event("metadata", "linear-metadata", {
          parentId: "linear-assistant",
          payload: { source: "plugin" },
        }),
      ],
    });

    phase = "fork";
    const fork = await forkChildTranscript(storePath, "parent-linear");
    phase = "read-child";
    const records = await childEvents(storePath, fork.sessionId);
    expect(records.slice(1)).toMatchObject([
      { id: "linear-user", parentId: null },
      { id: "linear-assistant", parentId: "linear-user" },
      { id: "linear-metadata", parentId: "linear-assistant" },
    ]);
    phase = "open-child";
    const reopened = await openForkedChildSession(storePath, fork);
    expect(reopened.buildSessionContext().messages).toHaveLength(2);
    phase = "append";
    await reopened.appendMessageAsync({
      role: "user",
      content: "continued",
      timestamp: Date.now(),
    });
    phase = "read-continued";
    const continuedRecords = await childEvents(storePath, fork.sessionId);
    expect(continuedRecords.at(-1)).toMatchObject({
      type: "message",
      parentId: "linear-metadata",
    });
  });

  it.each([false, true])(
    "branches the current parent CLI session and preserves child writes (writeDuringPreparation=%s)",
    async (writeDuringPreparation) => {
      const root = sessionDirs.make();
      const storePath = path.join(root, "sessions.json");
      const parentKey = "agent:main:main";
      const childKey = "agent:main:child";
      const parentSessionId = "parent-cli-binding";
      await replaceSessionEntry(
        { sessionKey: parentKey, storePath },
        {
          sessionId: parentSessionId,
          updatedAt: 1,
          cliSessionBindings: {
            "claude-cli": { sessionId: "native-parent", resumeCheckpointId: "parent-checkpoint" },
            "codex-cli": { sessionId: "codex-parent", resumeCheckpointId: "codex-checkpoint" },
          },
        },
      );
      await replaceSessionEntry(
        { sessionKey: childKey, storePath },
        {
          sessionId: "old-child",
          updatedAt: 1,
          totalTokens: 88_876,
          totalTokensFresh: true,
          totalTokensVersion: 1,
        },
      );
      const database = openOpenClawAgentDatabase(
        toDatabaseOptions(resolveSqliteStoreScope(storePath)),
      );
      let preparedWrite = false;
      cliBackendsTesting.setDepsForTest({
        resolveRuntimeCliBackends: () => [
          {
            ...forkableClaudeCliBackend,
            normalizeConfig: (config) => {
              expect(database.db.isTransaction).toBe(false);
              if (writeDuringPreparation && !preparedWrite) {
                preparedWrite = true;
                replaceSessionEntrySync(
                  { sessionKey: childKey, storePath },
                  {
                    ...loadSessionEntry({ sessionKey: childKey, storePath })!,
                    label: "concurrent child",
                  },
                );
                replaceSessionEntrySync(
                  { sessionKey: parentKey, storePath },
                  {
                    ...loadSessionEntry({ sessionKey: parentKey, storePath })!,
                    cliSessionBindings: {
                      "claude-cli": {
                        sessionId: "current-parent",
                        resumeCheckpointId: "current-checkpoint",
                      },
                    },
                  },
                );
              }
              return config;
            },
          },
        ],
        resolvePluginSetupCliBackend: () => undefined,
      });
      await seedParentTranscript({
        storePath,
        parentSessionId,
        events: [
          { type: "session", version: 3, id: parentSessionId, timestamp: "2026-05-01T00:00:00Z" },
          event("message", "parent-user", {
            parentId: null,
            message: { role: "user", content: "fork me" },
          }),
        ],
      });

      const result = await forkSessionEntryFromParentTarget({
        storePath,
        parentTarget: { canonicalKey: parentKey, storeKeys: [parentKey] },
        sessionTarget: { canonicalKey: childKey, storeKeys: [childKey] },
      });

      expect(result.status).toBe("forked");
      const childEntry = loadSessionEntry({ sessionKey: childKey, storePath });
      expect(childEntry?.label).toBe(writeDuringPreparation ? "concurrent child" : undefined);
      expect(childEntry?.totalTokens).toBeUndefined();
      expect(childEntry?.totalTokensFresh).toBe(false);
      expect(childEntry?.totalTokensVersion).toBeUndefined();
      // Backends without a fork flag would share the parent thread, so they start fresh.
      expect(loadSessionEntry({ sessionKey: childKey, storePath })?.cliSessionBindings).toEqual({
        "claude-cli": {
          sessionId: writeDuringPreparation ? "current-parent" : "native-parent",
          resumeCheckpointId: writeDuringPreparation ? "current-checkpoint" : "parent-checkpoint",
          forkNextResume: true,
        },
      });
      expect(
        loadSessionEntry({ sessionKey: parentKey, storePath })?.cliSessionBindings?.["claude-cli"],
      ).toEqual({
        sessionId: writeDuringPreparation ? "current-parent" : "native-parent",
        resumeCheckpointId: writeDuringPreparation ? "current-checkpoint" : "parent-checkpoint",
      });
    },
  );
});
