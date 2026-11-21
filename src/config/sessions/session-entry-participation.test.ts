import { expect } from "vitest";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { projectSessionSharingEntry } from "./session-accessor.sqlite-entry-cache.types.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { resetSessionEntryLifecycle } from "./session-accessor.sqlite-lifecycle.js";
import { captureSessionExecutionPolicy } from "./session-entry-execution-policy.js";
import { test } from "./session-entry-fixture.test-support.js";
import { preserveSessionLineage } from "./session-entry-lineage.js";
import {
  projectExecutionSessionEntry,
  projectPublicSessionEntry,
  projectPublicSessionEntryPatch,
} from "./session-entry-projection.js";

const participationCeiling = {
  kind: "send" as const,
  profileId: "participant",
  sessionKey: "agent:main:source",
  tools: ["read", "exec"],
  permission: "guarded" as const,
  source: {
    agentId: "main",
    sessionId: "source-id",
    lifecycleRevision: null,
    creatorProfileId: "creator",
    root: "/synthetic/participant-root",
  },
};

// Storage preserves constraints; live source membership remains a runtime admission decision.
test("retains participant constraints through stale replacements, reset, and cold reopening", async ({
  store,
}) => {
  store.replace({
    inheritedToolPolicySource: "participant",
    inheritedToolPolicyVersion: 1,
    inheritedToolAllow: ["read", "exec"],
    participationCeiling,
  });
  const initial = (await store.entry())!;
  const publicEntry = projectPublicSessionEntry(initial);
  expect(publicEntry).not.toHaveProperty("participationCeiling");
  expect(publicEntry).not.toHaveProperty("inheritedToolPolicySource");
  expect(projectPublicSessionEntryPatch(initial)).not.toHaveProperty("participationCeiling");
  expect(projectExecutionSessionEntry(initial).participationCeiling?.source?.root).toBe(
    "/synthetic/participant-root",
  );
  expect(
    captureSessionExecutionPolicy(projectSessionSharingEntry(initial))?.participationCeiling
      ?.permission,
  ).toBe("guarded");
  expect(preserveSessionLineage(initial).participationCeiling).toEqual(participationCeiling);

  // A full public row lacks private state, and a stale internal row can explicitly clear it.
  for (const next of [
    publicEntry,
    { ...publicEntry, participationCeiling: undefined, inheritedToolPolicySource: undefined },
    {
      ...publicEntry,
      inheritedToolPolicySource: "sender" as const,
      participationCeiling: {
        ...participationCeiling,
        permission: "full" as const,
        tools: ["read", "exec", "sessions_spawn"],
        source: { ...participationCeiling.source, creatorProfileId: "replacement-creator" },
      },
    },
  ]) {
    replaceSessionEntrySync(store.scope, { ...next, updatedAt: 2 });
    expect(await store.entry()).toMatchObject({
      participationCeiling,
      inheritedToolPolicySource: "participant",
    });
  }

  for (const sessionId of ["original", "rotated"]) {
    await resetSessionEntryLifecycle({
      ...store.store,
      target: { canonicalKey: store.sessionKey, storeKeys: [store.sessionKey] },
      buildNextEntry: () => ({ sessionId, lifecycleRevision: `reset-${sessionId}`, updatedAt: 3 }),
    });
    expect(await store.entry()).toMatchObject({
      sessionId,
      lifecycleRevision: `reset-${sessionId}`,
      participationCeiling,
      inheritedToolPolicySource: "participant",
    });
  }
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  const reopened = (await store.entry())!;
  expect(reopened).toMatchObject({
    sessionId: "rotated",
    participationCeiling,
    inheritedToolPolicySource: "participant",
  });
  replaceSessionEntrySync(store.scope, {
    sessionId: "rotated",
    lifecycleRevision: "reset-rotated",
    updatedAt: 4,
    label: "ordinary bookkeeping",
  });
  expect(await store.entry()).toMatchObject({
    label: "ordinary bookkeeping",
    participationCeiling,
    inheritedToolPolicySource: "participant",
  });
});

test("does not erase a participant marker whose envelope is missing", async ({ store }) => {
  store.replace({ inheritedToolPolicySource: "participant" });
  replaceSessionEntrySync(store.scope, { sessionId: "next", updatedAt: 2 });
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  expect(await store.entry()).toMatchObject({
    sessionId: "next",
    inheritedToolPolicySource: "participant",
  });
  expect(await store.entry()).not.toHaveProperty("participationCeiling");
});
