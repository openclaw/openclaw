import path from "node:path";
import { afterAll, describe, expect, expectTypeOf, it } from "vitest";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import {
  projectPluginSessionEntry,
  projectPluginSessionEntryPatch,
} from "./session-store-runtime-internal.js";
import {
  patchSessionEntry,
  upsertSessionEntry,
  type SessionEntry,
} from "./session-store-runtime.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-sdk-publication-");

function privateGenerationEntry(): InternalSessionEntry {
  return {
    activeWriterRunId: "writer-run",
    lifecycleRevision: "generation-1",
    lifecycleRunId: "lifecycle-run",
    sessionDiffBaselineCapture: { version: 1, captureId: "capture-1", status: "pending" },
    transcriptByteCompactionLatch: {
      activeBytes: 60_000,
      sessionId: "session-1",
      maxBytes: 50_000,
    },
    sessionId: "session-1",
    updatedAt: 10,
  };
}

function expectGenerationPrivateFieldsCleared(entry: InternalSessionEntry | undefined): void {
  expect(entry?.activeWriterRunId).toBeUndefined();
  expect(entry?.lifecycleRunId).toBeUndefined();
  expect(entry?.sessionDiffBaselineCapture).toBeUndefined();
  expect(entry?.transcriptByteCompactionLatch).toBeUndefined();
}

expectTypeOf<
  Extract<
    keyof SessionEntry,
    | "activeWriterRunId"
    | "sessionDiffBaselineCapture"
    | "transcriptByteCompactionLatch"
    | "thinkingLevelSelection"
  >
>().toEqualTypeOf<never>();
expectTypeOf<
  Extract<keyof NonNullable<SessionEntry["modelFallback"]>, "prevThinkingLevelSelection">
>().toEqualTypeOf<never>();

describe("plugin session writer claim projection", () => {
  it.each(["patch", "upsert"] as const)(
    "preserves server publication through %s lifecycle changes while rejecting forged grants",
    async (method) => {
      const storePath = path.join(sessionDirs.make(), "sessions.json");
      const scope = { sessionKey: "agent:main:plugin-publication", storePath };
      const publicShare = { id: "a".repeat(48), sessionId: "session-1", createdAt: 1 };
      const updatedAt = Date.now();
      await replaceSessionEntry(scope, { ...privateGenerationEntry(), publicShare, updatedAt });
      const mutate = (entry: InternalSessionEntry) =>
        method === "patch"
          ? patchSessionEntry({ ...scope, replaceEntry: true, update: () => entry })
          : upsertSessionEntry({ ...scope, entry });
      await mutate({
        sessionId: "session-1",
        lifecycleRevision: "generation-2",
        updatedAt,
        publicShare: { ...publicShare, id: "b".repeat(48) },
      });
      const sameSession = loadSessionEntry(scope);
      expect(sameSession?.sessionId).toBe("session-1");
      expect(sameSession?.publicShare).toEqual(publicShare);
      expectGenerationPrivateFieldsCleared(sameSession);

      await mutate({
        sessionId: "session-2",
        lifecycleRevision: "generation-3",
        updatedAt,
        publicShare: { ...publicShare, sessionId: "session-2", id: "c".repeat(48) },
      });
      expect(loadSessionEntry(scope)?.publicShare).toBeUndefined();
    },
  );

  it("excludes private claims and retired thinking provenance from entries and patches", () => {
    const publicFields = {
      model: "gpt-5.6",
      modelFallback: { prevModel: "gpt-5.5", prevProvider: "openai", source: "agent-patch", ts: 1 },
    };
    const {
      sessionId,
      updatedAt,
      lifecycleRevision: _revision,
      ...claims
    } = privateGenerationEntry();
    const patch = {
      ...claims,
      ...publicFields,
      modelFallback: {
        ...publicFields.modelFallback,
        prevThinkingLevelSelection: { retired: true },
      },
      thinkingLevelSelection: { retired: true },
    } as unknown as Partial<InternalSessionEntry>;
    expect(projectPluginSessionEntry({ ...patch, sessionId, updatedAt })).toEqual({
      ...publicFields,
      sessionId,
      updatedAt,
    });
    expect(projectPluginSessionEntryPatch(patch)).toEqual(publicFields);
  });

  it("preserves private generation fields when patches and upserts omit lifecycle revision", async () => {
    const scope = {
      sessionKey: "agent:main:patch-preserve-generation",
      storePath: path.join(sessionDirs.make(), "sessions.json"),
    };
    await replaceSessionEntry(scope, privateGenerationEntry());

    await patchSessionEntry({ ...scope, update: () => ({ model: "gpt-5.6" }) });

    const { updatedAt: _updatedAt, ...generation } = privateGenerationEntry();
    expect(loadSessionEntry(scope)).toMatchObject({ ...generation, model: "gpt-5.6" });

    await upsertSessionEntry({ entry: { sessionId: "session-1", updatedAt: 20 }, ...scope });
    expect(loadSessionEntry(scope)).toMatchObject(generation);
  });
});
