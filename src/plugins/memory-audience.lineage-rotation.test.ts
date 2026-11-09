import "../test-utils/prepare-compiled-subprocesses.js";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { acceptCompactionSuccessor } from "../agents/embedded-agent-runner/compaction-successor.js";
import { captureRuntimeConfigAsyncReader } from "../config/io.runtime.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  rewindSessionToMessage,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { performGatewaySessionReset } from "../gateway/session-reset-service.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveMemoryAudienceFromEntry } from "./memory-audience.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";

const ROOT_KEY = "agent:main:root";
const CHILD_KEY = "agent:main:subagent:child";

afterEach(() => resetPluginRuntimeStateForTest());

type Lineage = {
  env: NodeJS.ProcessEnv;
  storePath: string;
  root: SessionEntry;
  resolveChild: () => ReturnType<typeof resolveMemoryAudienceFromEntry>;
};

/** Commit a direct root with history and a child spawned from it by a non-owner. */
async function withSpawnedChild(
  options: { legacyReceipt?: boolean },
  run: (lineage: Lineage) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    const cfg = { agents: { entries: { main: {} } } };
    await state.writeConfig(cfg);
    await captureRuntimeConfigAsyncReader()();
    const { env } = state;
    const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
    const root: SessionEntry = {
      sessionId: randomUUID(),
      ...(options.legacyReceipt ? {} : { lifecycleRevision: randomUUID() }),
      chatType: "direct",
      updatedAt: 1,
    };
    const rootScope = { agentId: "main", env, sessionKey: ROOT_KEY, sessionId: root.sessionId };
    await upsertSessionEntryCore(rootScope, root);
    let parentId: string | null = null;
    for (const [id, role] of [
      ["user-1", "user"],
      ["assistant-1", "assistant"],
      ["user-2", "user"],
      ["assistant-2", "assistant"],
    ] as const) {
      await appendTranscriptMessage(rootScope, {
        eventId: id,
        parentId,
        message: { role, content: id },
      });
      parentId = id;
    }
    const child: SessionEntry = {
      sessionId: randomUUID(),
      lifecycleRevision: randomUUID(),
      updatedAt: 1,
      spawnedBy: ROOT_KEY,
      parentSessionKey: ROOT_KEY,
      spawnedBySessionId: root.sessionId,
      parentSessionLifecycleRevision: root.lifecycleRevision,
      spawnedBySenderIsOwner: false,
    };
    await upsertSessionEntryCore({ agentId: "main", env, sessionKey: CHILD_KEY }, child);
    await run({
      env,
      storePath,
      root,
      resolveChild: () =>
        resolveMemoryAudienceFromEntry(
          {
            agentId: "main",
            sessionKey: CHILD_KEY,
            sessionId: child.sessionId,
            senderIsOwner: false,
            storePath,
          },
          child,
        ),
    });
  });
}

function rewindRoot({ env }: Lineage) {
  return rewindSessionToMessage({ agentId: "main", env, sessionKey: ROOT_KEY, entryId: "user-2" });
}

function compactRoot({ env, storePath, root }: Lineage) {
  const target = {
    agentId: "main",
    env,
    sessionKey: ROOT_KEY,
    sessionId: root.sessionId,
    storePath,
  };
  return acceptCompactionSuccessor({
    currentTarget: target,
    expectedEntry: {
      sessionId: root.sessionId,
      lifecycleRevision: root.lifecycleRevision,
      activeWriterRunId: undefined,
    },
    assertActive: () => {},
    config: {},
    result: {
      ok: true,
      compacted: true,
      result: {
        summary: "compacted",
        tokensBefore: 2,
        tokensAfter: 1,
        sessionTarget: { sessionId: randomUUID() },
      },
    },
  });
}

function readRoot({ env }: Lineage) {
  const entry = loadSessionEntry({ agentId: "main", env, sessionKey: ROOT_KEY });
  if (!entry) {
    throw new Error("root session row is missing");
  }
  return entry;
}

it.each([
  ["rewind", rewindRoot],
  ["compaction", compactRoot],
] as const)(
  "keeps a child's memory after its parent's %s rotates the session id",
  (_path, rotate) =>
    withSpawnedChild({}, async (lineage) => {
      await rotate(lineage);
      const rotated = readRoot(lineage);
      expect(rotated.sessionId).not.toBe(lineage.root.sessionId);
      expect(rotated.lifecycleRevision).toBe(lineage.root.lifecycleRevision);

      const resolution = await lineage.resolveChild();
      if (resolution.status !== "granted") {
        throw new Error(resolution.reason);
      }
      // The child shares the partition its parent now writes, not the retired one.
      expect(resolution.audience).toEqual({
        kind: "conversation",
        agentId: "main",
        sessionKey: ROOT_KEY,
        sessionId: rotated.sessionId,
      });
      resolution.release();
    }),
);

it("denies a child's memory after its parent is reset", () =>
  withSpawnedChild({}, async (lineage) => {
    const reset = await performGatewaySessionReset({
      key: ROOT_KEY,
      agentId: "main",
      reason: "reset",
      commandSource: "test",
      operatorRoleActor: { kind: "system" },
      workerPlacementContext: {},
    });
    expect(reset).toMatchObject({ ok: true });
    expect(readRoot(lineage).lifecycleRevision).not.toBe(lineage.root.lifecycleRevision);

    await expect(lineage.resolveChild()).resolves.toMatchObject({
      status: "denied",
      kind: "stale-lineage",
    });
  }));

it("keeps comparing session ids for a receipt that recorded no lifecycle revision", () =>
  withSpawnedChild({ legacyReceipt: true }, async (lineage) => {
    const granted = await lineage.resolveChild();
    expect(granted).toMatchObject({ status: "granted" });
    if (granted.status === "granted") {
      granted.release();
    }

    await rewindRoot(lineage);
    expect(readRoot(lineage).lifecycleRevision).toBeUndefined();
    await expect(lineage.resolveChild()).resolves.toMatchObject({
      status: "denied",
      kind: "stale-lineage",
    });
  }));
