import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { readCodexSessionContext } from "../../plugin-sdk/codex-session-transcript-runtime.js";
import { ModelSelectionLockedError } from "../../sessions/model-selection-error.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import {
  forkSessionEntryFromParent,
  forkSessionFromParent,
  MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE,
  resolveParentForkDecision,
} from "./session-fork.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-session-fork-boundary-");
const parentSessionKey = "agent:main:main";
const sessionKey = "agent:main:subagent:child";
let root: string;
let storePath: string;

beforeEach(() => {
  root = sessionDirs.make();
  storePath = path.join(root, "sessions.json");
});

function forkChild(overrides: Partial<Parameters<typeof forkSessionEntryFromParent>[0]> = {}) {
  return forkSessionEntryFromParent({
    agentId: "main",
    fallbackEntry: { sessionId: "", updatedAt: 2 },
    parentSessionKey,
    sessionKey,
    storePath,
    ...overrides,
  });
}

function messageEvent(id: string, parentId: string | null, message: Record<string, unknown>) {
  return { type: "message", id, parentId, timestamp: "2026-06-27T00:00:01.000Z", message };
}

function replaceParentTranscript(
  transcriptRoot: string,
  transcriptStorePath: string,
  sessionId: string,
  events: Parameters<typeof replaceTranscriptEvents>[1],
) {
  return replaceTranscriptEvents(
    { agentId: "main", sessionId, sessionKey: parentSessionKey, storePath: transcriptStorePath },
    [
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-06-27T00:00:00.000Z",
        cwd: transcriptRoot,
      },
      ...events,
    ],
  );
}

function makeParentEntry(totalTokens: number, totalTokensFresh = false) {
  return { sessionId: "parent-session", totalTokens, totalTokensFresh, updatedAt: 1 };
}

function writeParent(entry: InternalSessionEntry) {
  return replaceSessionEntry({ agentId: "main", sessionKey: parentSessionKey, storePath }, entry);
}

function billingUsage(contextUsage: Record<string, unknown>) {
  return {
    input: 12,
    output: 15_104,
    cacheRead: 819_661,
    cacheWrite: 93_130,
    contextUsage,
    total: 927_907,
  };
}

describe("forkSessionEntryFromParent", () => {
  it("rejects model-selection-locked parent context", async () => {
    const parentEntry = {
      sessionId: "locked-parent",
      modelSelectionLocked: true,
      updatedAt: 1,
    };
    await expect(
      resolveParentForkDecision({ parentEntry, storePath: "/tmp/unused-sessions.json" }),
    ).rejects.toThrow(MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE);
    await expect(
      forkSessionFromParent({
        agentId: "main",
        parentEntry,
        parentSessionKey: "agent:main:main",
        sessionKey: "agent:main:subagent:child",
        storePath: "/tmp/unused-sessions.json",
      }),
    ).rejects.toThrow(MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE);
  });

  it("rejects a newer locked parent alias shadowed by a stale canonical row", async () => {
    await replaceSessionEntry(
      { agentId: "main", sessionKey: "agent:main:main", storePath },
      { sessionId: "stale-canonical-parent", updatedAt: 1 },
    );
    await replaceSessionEntry(
      { agentId: "main", sessionKey: "main", storePath },
      {
        sessionId: "fresh-locked-parent",
        modelSelectionLocked: true,
        updatedAt: 2,
      },
    );

    const fork = forkChild({
      fallbackEntry: { sessionId: "", updatedAt: 3 },
      parentStoreKeys: ["agent:main:main", "main"],
    });
    await expect(fork).rejects.toBeInstanceOf(ModelSelectionLockedError);
    await expect(fork).rejects.toThrow(MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE);
    expect(
      loadSessionEntry({ agentId: "main", sessionKey: "agent:main:subagent:child", storePath }),
    ).toBeUndefined();
  });

  it("persists the forked child in the active store instead of the configured store", async () => {
    await writeParent(makeParentEntry(10, true));
    await replaceParentTranscript(root, storePath, "parent-session", [
      messageEvent("answer", null, { role: "assistant", content: "parent context" }),
    ]);

    const result = await forkChild({
      config: { session: { store: path.join(root, "configured", "sessions.json") } },
      fallbackEntry: { lifecycleRunId: "pre-fork-run", sessionId: "", updatedAt: 2 },
      parentStoreKeys: [parentSessionKey],
      entryPatch: { forked: { label: "forked child", updatedAt: 3 } },
    });

    if (result.status !== "forked") {
      throw new Error("expected fork");
    }
    expect(fs.existsSync(storePath)).toBe(false);

    const stored = loadSessionEntry({ agentId: "main", sessionKey, storePath });
    expect(stored).toMatchObject({
      label: "forked child",
      sessionId: result.fork.sessionId,
    });
    expect((stored as InternalSessionEntry | undefined)?.lifecycleRunId).toBeUndefined();
  });

  it.each([true, false])(
    "leaves oversized children unmaterialized (fresh total=%s)",
    async (fresh) => {
      const parent = {
        ...makeParentEntry(fresh ? 150_000 : 900_000, fresh),
        totalTokensVersion: 1 as const,
      };
      if (!fresh) {
        await replaceParentTranscript(root, storePath, parent.sessionId, [
          messageEvent("usage", null, {
            role: "assistant",
            content: "latest",
            usage: billingUsage({
              state: "available",
              promptTokens: 148_874,
              totalTokens: 163_978,
            }),
          }),
        ]);
      }
      await writeParent(parent);
      expect(await forkChild()).toMatchObject({
        status: "skipped",
        reason: "decision-skip",
        decision: {
          status: "skip",
          reason: "parent-too-large",
          parentTokens: fresh ? 150_000 : 163_978,
        },
        sessionEntry: { sessionId: "", updatedAt: expect.any(Number) },
      });
      expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toBeUndefined();
    },
  );

  it("does not reconstruct SQLite parent context from billing buckets when context is unavailable", async () => {
    const parent = makeParentEntry(4_567);
    await replaceParentTranscript(root, storePath, parent.sessionId, [
      messageEvent("usage", null, {
        role: "assistant",
        content: "latest",
        usage: billingUsage({ state: "unavailable" }),
      }),
    ]);

    const decision = await resolveParentForkDecision({ parentEntry: parent, storePath });
    expect(decision).toMatchObject({ status: "fork", parentTokens: expect.any(Number) });
    if (decision.status !== "fork" || decision.parentTokens === undefined) {
      throw new Error("expected a transcript-estimated fork decision");
    }
    expect(decision.parentTokens).toBeLessThan(parent.totalTokens);
  });

  it.each(["compaction", "reset"] as const)(
    "forks retained messages without reviving their usage before %s",
    async (boundaryType) => {
      const parent = { ...makeParentEntry(10_000, true), totalTokensVersion: 1 as const };
      await replaceParentTranscript(root, storePath, parent.sessionId, [
        messageEvent("retained", null, {
          role: "assistant",
          content: "retained answer",
          __openclaw: { upstreamUserText: "private replay ".repeat(35_000) },
          providerReplay: {
            v: 1,
            type: "openai-responses-compaction",
            data: "retired checkpoint ".repeat(25_000),
            provider: "openai",
            api: "openai-responses",
            model: "gpt-5.6-luna",
            baseUrlHash: "synthetic",
          },
          usage: { contextUsage: { state: "available", totalTokens: 150_000 } },
        }),
        { type: "opaque-synthetic", id: "opaque-keep", parentId: "retained" },
        {
          type: boundaryType,
          id: "boundary",
          parentId: "opaque-keep",
          timestamp: "2026-06-27T00:00:02.000Z",
          firstKeptEntryId: "opaque-keep",
          ...(boundaryType === "compaction"
            ? { summary: "compact context", tokensBefore: 150_000 }
            : { reason: "reset" }),
        },
      ]);
      await writeParent(parent);

      const result = await forkChild();
      expect(result).toMatchObject({
        decision: { status: "fork", parentTokens: 10_000 },
      });
      if (result.status !== "forked") {
        throw new Error("expected fork");
      }
      await expect(
        loadTranscriptEvents({
          agentId: "main",
          sessionId: result.fork.sessionId,
          sessionKey,
          storePath,
        }),
      ).resolves.toContainEqual(expect.objectContaining({ id: "retained" }));
      const context = readCodexSessionContext(
        { agentId: "main", sessionId: result.fork.sessionId, sessionKey, storePath },
        (messages) => Array.from(messages),
      );
      expect(context).toContainEqual(expect.objectContaining({ content: "retained answer" }));
    },
  );

  it.each([
    { fresh: false, side: false },
    { fresh: true, side: false },
    { fresh: true, side: true },
  ])(
    "rejects post-usage transcript growth with freshness $fresh and selected side append $side",
    async ({ fresh, side }) => {
      const parent = { ...makeParentEntry(80_000, fresh), totalTokensVersion: 1 as const };
      const parentScope = {
        agentId: "main",
        sessionId: parent.sessionId,
        sessionKey: parentSessionKey,
        storePath,
      };
      await replaceParentTranscript(root, storePath, parent.sessionId, [
        messageEvent("usage", null, {
          role: "assistant",
          content: "latest model call",
          usage: {
            input: 12,
            output: 10_000,
            contextUsage: {
              state: "available",
              promptTokens: 70_000,
              totalTokens: 80_000,
            },
          },
        }),
      ]);
      await writeParent(parent);
      await appendTranscriptMessage(parentScope, {
        eventId: "tool-call",
        parentId: "usage",
        message: {
          role: "assistant",
          stopReason: "toolUse",
          content: [
            {
              type: "toolCall",
              id: "tail-call",
              name: "exec",
              arguments: { command: "synthetic tail" },
            },
          ],
        },
      });
      const tailText = `large appended tool result ${"x".repeat(100_000)}`;
      await appendTranscriptMessage(parentScope, {
        eventId: "tail",
        parentId: "tool-call",
        message: {
          role: "toolResult",
          toolCallId: "tail-call",
          toolName: "exec",
          content: [{ type: "text", text: tailText }],
          isError: false,
        },
      });
      if (side) {
        // Imported transcripts can select side-appended context with a leaf control.
        const events = await loadTranscriptEvents(parentScope);
        for (const event of events) {
          if (isRecord(event) && (event.id === "tool-call" || event.id === "tail")) {
            event.appendMode = "side";
          }
        }
        await replaceTranscriptEvents(parentScope, events);
        await appendTranscriptEvent(parentScope, {
          type: "leaf",
          id: "selected-tail",
          parentId: "tail",
          targetId: "tail",
          appendParentId: "tail",
        });
      }
      const storedParent = loadSessionEntry({
        agentId: "main",
        sessionKey: parentSessionKey,
        storePath,
      });
      expect(storedParent).toMatchObject({
        totalTokens: 80_000,
        totalTokensFresh: fresh,
        totalTokensVersion: 1,
      });

      const result = await forkChild();
      const decision =
        result.status === "forked" || result.status === "skipped" ? result.decision : undefined;
      expect(result).toMatchObject({
        status: "skipped",
        reason: "decision-skip",
        decision: { status: "skip", reason: "parent-too-large", parentTokens: expect.any(Number) },
      });
      expect(decision?.parentTokens).toBeGreaterThan(100_000);
      expect(decision?.parentTokens).toBeLessThan(110_000);
    },
  );
});
