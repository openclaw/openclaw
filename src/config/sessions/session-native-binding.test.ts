import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createNativeSessionCommitFinalizer } from "../../agents/harness/native-session/deletion-participant.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { capturePluginStateNativeBindingFacts } from "../../plugin-state/plugin-state-native-binding-facts.js";
import { createPluginStateKeyedStoreV2 } from "../../plugin-state/plugin-state-store.js";
import { capturePluginStateNativeBindingStore } from "../../plugin-state/plugin-state-store.native-binding.js";
import { onSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import * as execution from "../../state/openclaw-agent-execution.js";
import { readSessionArchiveContentSync } from "./archive-compression.js";
import * as native from "./session-native-binding.execution.test-support.js";
import { withNativeBindingFixture } from "./session-native-binding.test-support.js";

afterEach(() => vi.restoreAllMocks());
type Fixture = Parameters<Parameters<typeof withNativeBindingFixture>[1]>[0];
const withCodex = (run: (fixture: Fixture) => Promise<void>, mode?: "worker" | "legacy") =>
  withNativeBindingFixture("codex", run, mode);

it.each(["sibling", "retired", "absent", "stale"] as const)(
  "handles a %s Codex binding through the host worker",
  (condition) =>
    withCodex(async ({ bindingKey, bindingStore, readEntry, readBinding, remove, scope }) => {
      const [entry, binding] = [readEntry(), readBinding()] as const;
      const successor = { ...binding, sessionId: "new-generation" };
      const siblingKey = `${bindingKey}:sibling`;
      if (condition === "absent") {
        bindingStore.delete(bindingKey);
      } else {
        const value = {
          retired: { version: 1, state: "cleared", sessionId: scope.sessionId, retired: true },
          stale: successor,
          sibling: binding!,
        }[condition];
        bindingStore.register(condition === "sibling" ? siblingKey : bindingKey, value);
      }
      if (condition === "stale") {
        await expect(remove()).rejects.toThrow("generation changed");
      } else {
        await expect(remove()).resolves.toMatchObject({ deleted: true });
      }
      expect([readEntry(), readBinding()]).toEqual(
        condition === "stale" ? [entry, successor] : [undefined, undefined],
      );
      if (condition === "sibling") {
        expect(bindingStore.lookup(siblingKey)).toEqual(binding);
      }
    }),
);

it("uses each installed plugin owner's packaged codec during real binding deletion", () =>
  withCodex(async ({ registry, database, readEntry, readBinding, remove }) => {
    const before = [readEntry(), readBinding()];
    for (const generation of ["first", "second"]) {
      const rootDir = path.join(path.dirname(database.path), `installed-${generation}`);
      mkdirSync(path.join(rootDir, "dist"), { recursive: true });
      writeFileSync(path.join(rootDir, "package.json"), '{"type":"module"}');
      const message = `synthetic installed ${generation} codec refusal`;
      writeFileSync(
        path.join(rootDir, "dist", "native-session-binding-api.js"),
        `export function readNativeSessionBindingRecord() { throw new Error(${JSON.stringify(message)}); }`,
      );
      Object.assign(registry.plugins[0]!, {
        rootDir,
        source: path.join(rootDir, "dist", "index.js"),
        origin: "global",
      });
      await expect(remove()).rejects.toMatchObject({
        code: "PLUGIN_STATE_WRITE_FAILED",
        cause: { message },
      });
      expect([readEntry(), readBinding()]).toEqual(before);
    }
  }));

it("keeps archive bytes and identity publication equivalent with a legacy cleanup companion", async () => {
  const outcomes: unknown[] = [];
  for (const mode of ["legacy", "worker"] as const) {
    await withCodex(async ({ scope, readEntry, readBinding, remove, events }) => {
      const notifications: unknown[] = [];
      const unsubscribe = onSessionIdentityMutation((event) => {
        if (event.kind === "delete" && event.previous.sessionKeys.includes(scope.sessionKey)) {
          notifications.push({ kind: event.kind, previous: event.previous });
        }
      });
      const sql = observeHostDataSql();
      try {
        const result = await remove({ archiveTranscript: true });
        expect(native.bindingWrites(sql.queries)).toEqual([]);
        expect(result.deleted).toBe(true);
        expect(result.archivedTranscripts).toHaveLength(1);
        const bytes = readSessionArchiveContentSync(result.archivedTranscripts[0]!.archivedPath);
        const transcript = bytes
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(transcript).toEqual(events);
        outcomes.push({ bytes, notifications, entry: readEntry(), binding: readBinding() });
      } finally {
        sql.restore();
        unsubscribe();
      }
    }, mode);
  }
  expect(outcomes[1]).toEqual(outcomes[0]);
});

it("restores the exact removed Codex row after A fails", () =>
  withCodex(async ({ bindingStore, bindingKey, readEntry, readBinding, remove }) => {
    const before = readEntry();
    const failure = new Error("synthetic agent COMMIT refusal");
    let removed: Record<string, unknown> | undefined;
    let restored: Record<string, unknown> | undefined;
    let agentCommit = false;
    let fixtureWrite = false;
    native.observeNativeGrants(admission, (request, facts) => {
      if (facts.kind === "native-binding-ready") {
        removed = { ...readBinding(), ignoredByCodec: { keep: ["exact", 7] } };
        fixtureWrite = true;
        try {
          bindingStore.register(bindingKey, removed);
        } finally {
          fixtureWrite = false;
        }
      }
      if (request.stage === "commit" && facts.kind === "session-native-binding") {
        agentCommit = true;
        expect(readBinding()).toBeUndefined();
        throw failure;
      }
    });
    native.spyAgentExecutions(execution, (worker) => ({
      execute: async (command, options) => {
        try {
          return await worker.execute(command, options);
        } finally {
          if (command.type === "session.nativeBindings.delete") {
            restored = readBinding();
          }
        }
      },
    }));
    const measured: string[] = [];
    await native.withHostDataSql(
      async () => {
        await expect(remove()).rejects.toBe(failure);
        expect(agentCommit).toBe(true);
        // Exclude only this test's explicit before-image write, not the owner's restoration.
        expect(native.bindingWrites(measured)).toEqual([]);
      },
      (query) => {
        if (!fixtureWrite) {
          measured.push(query);
        }
      },
    );
    expect(readEntry()).toEqual(before);
    assert(removed && restored);
    const { lease: originalLease, ...originalValue } = removed;
    const { lease: restoredLease, ...restoredValue } = restored;
    expect(restoredValue).toEqual(originalValue);
    assert(isRecord(originalLease) && typeof originalLease.expiresAt === "number");
    assert(isRecord(restoredLease) && typeof restoredLease.expiresAt === "number");
    expect(restoredLease).toMatchObject({ token: originalLease.token });
    expect(restoredLease.expiresAt).toBeGreaterThanOrEqual(originalLease.expiresAt);
  }));

it.each(["absent", "expired lease"] as const)(
  "rechecks the %s predicate inside the executing worker before deleting the binding",
  (condition) =>
    withNativeBindingFixture(
      "agentsapi",
      async ({ bindingStore, bindingKey, readEntry, readBinding, remove }) => {
        const before = readEntry();
        const binding = readBinding();
        expect(binding).toBeDefined();
        if (condition === "absent") {
          bindingStore.delete(bindingKey);
        }
        let checked = false;
        let current: Record<string, unknown> | undefined;
        native.observeNativeGrants(admission, (_request, facts) => {
          if (facts.kind !== "native-binding-ready" || checked) {
            return;
          }
          checked = true;
          const held = readBinding();
          current =
            condition === "absent"
              ? { ...binding, sessionId: "successor-created-after-preparation" }
              : { ...held, lease: { ...(isRecord(held?.lease) ? held.lease : {}), expiresAt: 1 } };
          bindingStore.register(bindingKey, current);
        });
        await expect(remove()).rejects.toThrow("binding changed before session deletion");
        expect({ checked, entry: readEntry() }).toEqual({ checked: true, entry: before });
        if (condition === "absent") {
          expect(readBinding()).toEqual(current);
        } else {
          // Normal lease release may remove the expired lease after the veto; the native value survives.
          expect(readBinding()).toMatchObject(binding!);
        }
      },
    ),
);

it.each([
  { acp: true, rollback: false },
  { acp: true, rollback: true },
  { acp: false, rollback: false },
  { acp: false, rollback: true },
])("settles acknowledged deletion (ACP: $acp, rollback: $rollback)", ({ acp, rollback }) =>
  withNativeBindingFixture(
    "agentsapi",
    async ({ scope, bindingStore, bindingKey, harness, readEntry, readBinding, remove }) => {
      const legacy = {
        sessionId: "synthetic-agentsapi-session",
        authFingerprint: "3c26b68488ce497a69d2c9fce9ee19c461fa67a3d959b0dc3bafe5718c56119d",
      };
      const finalized = vi.fn();
      const rolledBack = vi.fn();
      let authority: Awaited<ReturnType<typeof capturePluginStateNativeBindingFacts>> | undefined;
      if (acp) {
        bindingStore.delete(bindingKey);
        harness.withSessionDeletion = (_params, run) =>
          run(createNativeSessionCommitFinalizer({ commit: finalized, rollback: rolledBack }));
      } else {
        bindingStore.register(bindingKey, legacy);
        const store = createPluginStateKeyedStoreV2(
          "agentsapi",
          {
            namespace: "agentsapi-sessions",
            maxEntries: 100_000,
            overflowPolicy: "reject-new",
            env: scope.env,
          },
          { assertCurrent() {} },
        );
        authority = await capturePluginStateNativeBindingFacts(
          capturePluginStateNativeBindingStore(store)!,
          bindingKey,
          true,
        );
        expect(authority.read()).toEqual(legacy);
      }
      const before = readEntry();
      const failure = new Error("synthetic deletion COMMIT refusal");
      const commitSeen = native.observeNativeCommit(admission, () => {
        if (acp) {
          expect(finalized).not.toHaveBeenCalled();
        } else {
          expect(readBinding()).toBeUndefined();
          expect(() => authority!.read()).toThrow("authority is unavailable");
        }
        if (rollback) {
          throw failure;
        }
      });
      const sql = observeHostDataSql();
      try {
        if (rollback) {
          await expect(remove()).rejects.toBe(failure);
        } else {
          await expect(remove()).resolves.toMatchObject({ deleted: true });
        }
        expect(commitSeen).toHaveBeenCalled();
        expect(native.bindingWrites(sql.queries)).toEqual([]);
        expect(readEntry()).toEqual(rollback ? before : undefined);
        if (acp) {
          expect(finalized).toHaveBeenCalledTimes(rollback ? 0 : 1);
          expect(rolledBack).toHaveBeenCalledTimes(rollback ? 1 : 0);
        } else {
          expect([authority!.read(), readBinding()]).toEqual(
            rollback ? [legacy, legacy] : [undefined, undefined],
          );
        }
      } finally {
        authority?.release();
        sql.restore();
      }
    },
  ),
);
