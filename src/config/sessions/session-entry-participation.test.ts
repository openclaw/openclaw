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

const delegatedOperatorSource = { kind: "unavailable" as const, reason: "no-source" as const };

// Storage preserves constraints; live source membership remains a runtime admission decision.
test("retains delegated source bindings through stale replacements, reset, and cold reopening", async ({
  store,
}) => {
  store.replace({
    inheritedToolPolicyVersion: 1,
    inheritedToolAllow: ["read", "exec"],
    delegatedOperatorSource,
  });
  const initial = (await store.entry())!;
  const publicEntry = projectPublicSessionEntry(initial);
  expect(publicEntry).not.toHaveProperty("delegatedOperatorSource");
  expect(projectPublicSessionEntryPatch(initial)).not.toHaveProperty("delegatedOperatorSource");
  expect(projectExecutionSessionEntry(initial).delegatedOperatorSource).toEqual(
    delegatedOperatorSource,
  );
  expect(
    captureSessionExecutionPolicy(projectSessionSharingEntry(initial))?.delegatedOperatorSource,
  ).toEqual(delegatedOperatorSource);
  expect(preserveSessionLineage(initial).delegatedOperatorSource).toEqual(delegatedOperatorSource);

  // A full public row lacks private state, and a stale internal row can explicitly clear it.
  for (const next of [
    publicEntry,
    { ...publicEntry, delegatedOperatorSource: undefined, inheritedToolPolicySource: undefined },
    {
      ...publicEntry,
      inheritedToolPolicySource: "sender" as const,
      delegatedOperatorSource: { kind: "unavailable" as const, reason: "unauthenticated" as const },
    },
  ]) {
    replaceSessionEntrySync(store.scope, { ...next, updatedAt: 2 });
    expect(await store.entry()).toMatchObject({
      delegatedOperatorSource,
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
      delegatedOperatorSource,
    });
  }
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  const reopened = (await store.entry())!;
  expect(reopened).toMatchObject({
    sessionId: "rotated",
    delegatedOperatorSource,
  });
  replaceSessionEntrySync(store.scope, {
    sessionId: "rotated",
    lifecycleRevision: "reset-rotated",
    updatedAt: 4,
    label: "ordinary bookkeeping",
  });
  expect(await store.entry()).toMatchObject({
    label: "ordinary bookkeeping",
    delegatedOperatorSource,
  });
});
