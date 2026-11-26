import { expect, it } from "vitest";
import { rewriteDoctorSessionEntries } from "../../commands/doctor/shared/session-entry-rewrite.js";
import {
  applySessionEntryPatch,
  prepareSessionEntryPatch,
  upsertSessionEntry,
} from "../../plugin-sdk/session-store-runtime.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import {
  applySessionEntryOperation,
  patchSessionEntryCore,
  replaceSessionEntrySync,
} from "./session-accessor.sqlite-entry.js";
import { createSessionCompoundWorkerFixture } from "./session-compound-worker.test-support.js";

function archivedFixture() {
  const f = createSessionCompoundWorkerFixture();
  const options = { agentId: f.scope.agentId, path: f.scope.storePath };
  const receipt = { digest: "test-archive-digest", expiresAt: Date.now() + 3_600_000 };
  const archive = (kind: "archive" | "undo") =>
    runOpenClawAgentWriteTransaction(
      (database) =>
        writeSessionEntry(
          database,
          f.scope.sessionKey,
          {
            ...f.read()!,
            archivedAt: kind === "archive" ? 10 : undefined,
          },
          { archiveUndo: { kind, ...receipt } },
        ),
      options,
    );
  archive("archive");
  return { ...f, archive: () => archive("archive"), undo: () => archive("undo") };
}

it("preserves Archive Undo across omitted fields and rejected or null reducers", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = archivedFixture();
    const options = { skipMaintenance: true, preserveActivity: true };
    await applySessionEntryPatch({ ...f.scope, ...options, patch: { label: "SDK rename" } });
    await prepareSessionEntryPatch({
      ...f.scope,
      ...options,
      prepare: async () => ({ label: "prepared rename" }),
    });
    await expect(
      applySessionEntryPatch({
        ...f.scope,
        ...options,
        expected: { sessionId: "stale" },
        patch: { pinnedAt: undefined },
      }),
    ).rejects.toThrow("conditional patch");
    await patchSessionEntryCore(f.scope, async () => null, { ...options, replaceEntry: true });
    await applySessionEntryOperation(
      f.scope,
      {
        kind: "compound",
        operations: [
          { kind: "fields", expected: { sessionId: "stale" }, patch: { archivedAt: 10 } },
          { kind: "fields", patch: { label: "worker rename" } },
        ],
      },
      options,
    );
    const current = f.read()!;
    await applySessionEntryOperation(
      f.scope,
      {
        kind: "cron-session",
        sessionKey: f.scope.sessionKey,
        initial: current,
        next: { ...current, totalTokens: 42 },
        creation: { createdVia: "cron", createdActor: { type: "system" }, createdAt: 1 },
      },
      { ...options, replaceEntry: true },
    );
    expect(f.undo()).toMatchObject({ label: "worker rename", totalTokens: 42 });
    expect(f.read()?.archivedAt).toBeUndefined();
  });
});

it.each(["public-fields", "callback", "compound", "SDK upsert", "native replace"] as const)(
  "invalidates Archive Undo on a successful %s write even when the entry is unchanged",
  async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = archivedFixture();
      const options = { skipMaintenance: true, preserveActivity: true };
      // Publish a full resident postimage before an equal fixed operation can take the host shortcut.
      await applySessionEntryOperation(
        f.scope,
        { kind: "fields", patch: { label: "resident" } },
        options,
      );
      switch (kind) {
        case "public-fields":
          await applySessionEntryPatch({ ...f.scope, ...options, patch: { pinnedAt: undefined } });
          break;
        case "callback":
          await patchSessionEntryCore(
            f.scope,
            async (entry) => ({ archivedAt: entry.archivedAt }),
            options,
          );
          break;
        case "compound":
          await applySessionEntryOperation(
            f.scope,
            {
              kind: "compound",
              operations: [
                { kind: "fields", patch: { pinnedAt: undefined } },
                { kind: "fields", patch: { label: "resident" } },
              ],
            },
            options,
          );
          break;
        case "SDK upsert":
          await upsertSessionEntry({ ...f.scope, entry: f.read()! });
          break;
        case "native replace":
          replaceSessionEntrySync(f.scope, f.read()!);
          break;
      }
      expect(f.undo).toThrow("no longer current");
      expect(f.read()?.archivedAt).toBe(10);
    });
  },
);

it.each(["raw", "typed"] as const)("Doctor %s rewrites retire only affected Undo", async (kind) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = archivedFixture();
    const rewrite = (patch: { label?: string; pinnedAt?: number }) => {
      const target = { scope: f.scope, sessionKeys: [f.scope.sessionKey] };
      return kind === "raw"
        ? rewriteDoctorSessionEntries({
            ...target,
            rawTransform: (entry) => ({ entry: { ...entry, ...patch } }),
          })
        : rewriteDoctorSessionEntries({
            ...target,
            transform: (entry) => ({ ...entry, ...patch }),
          });
    };
    expect(rewrite({ label: "repaired" })).toBe(1);
    expect(f.undo()).toMatchObject({ label: "repaired" });
    f.archive();
    expect(rewrite({ pinnedAt: 731 })).toBe(1);
    expect(f.undo).toThrow("no longer current");
    expect(f.read()).toMatchObject({ archivedAt: 10, pinnedAt: 731 });
  });
});
