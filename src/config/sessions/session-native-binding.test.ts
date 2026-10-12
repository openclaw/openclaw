import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createNativeSessionCommitFinalizer } from "../../agents/harness/native-session/deletion-participant.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { onSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import { readSessionArchiveContentSync } from "./archive-compression.js";
import { loadTranscriptEventsSync } from "./session-accessor.sqlite-read.js";
import { withNativeBindingFixture } from "./session-native-binding.test-support.js";

const delivery = vi.hoisted(() => ({ afterExecution: undefined as (() => void) | undefined }));
vi.mock("../../state/openclaw-agent-execution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/openclaw-agent-execution.js")>();
  return {
    ...actual,
    captureOpenClawAgentDatabaseExecution: (
      ...args: Parameters<typeof actual.captureOpenClawAgentDatabaseExecution>
    ): ReturnType<typeof actual.captureOpenClawAgentDatabaseExecution> => {
      const owner = actual.captureOpenClawAgentDatabaseExecution(...args);
      return {
        ...owner,
        get fileIdentity() {
          return owner.fileIdentity;
        },
        runExisting: (source, operation, options) =>
          owner.runExisting(
            source,
            (worker) =>
              operation({
                execute: async (command, commandOptions) => {
                  try {
                    return await worker.execute(command, commandOptions);
                  } finally {
                    if (command.type === "session.nativeBindings.delete") {
                      delivery.afterExecution?.();
                    }
                  }
                },
              }),
            options,
          ),
      };
    },
  };
});

afterEach(() => {
  delivery.afterExecution = undefined;
  vi.restoreAllMocks();
});

function observeNativeGrants(
  observe: (
    request: admission.SqliteWorkerAdmissionRequest,
    publication: Record<string, unknown>,
  ) => void,
) {
  probe.admission(admission, (request, grant, admit) => {
    if (isRecord(request.facts) && isRecord(request.facts.publication)) {
      observe(request, request.facts.publication);
    }
    admit(request, grant);
  });
}

const bindingWrites = (queries: readonly string[]) =>
  queries.filter((sql) =>
    /\b(?:delete\s+from|insert(?:\s+or\s+\w+)?\s+into)\s+["`]?plugin_state_entries\b/i.test(sql),
  );

it("deletes only the requested Codex binding owner through the host worker", async () => {
  await withNativeBindingFixture("codex", async (fixture) => {
    const siblingKey = `${fixture.bindingKey}:sibling`;
    const sibling = fixture.readBinding();
    fixture.bindingStore.register(siblingKey, sibling!);
    await expect(fixture.remove()).resolves.toMatchObject({ deleted: true });
    expect(fixture.readBinding()).toBeUndefined();
    expect(fixture.bindingStore.lookup(siblingKey)).toEqual(sibling);
  });
});

it.each(["retired", "absent"] as const)(
  "deletes the session without leaving a %s Codex binding row",
  async (condition) => {
    await withNativeBindingFixture("codex", async (fixture) => {
      if (condition === "retired") {
        fixture.bindingStore.register(fixture.bindingKey, {
          version: 1,
          state: "cleared",
          sessionId: fixture.scope.sessionId,
          retired: true,
        });
      } else {
        fixture.bindingStore.delete(fixture.bindingKey);
      }
      await expect(fixture.remove()).resolves.toMatchObject({ deleted: true });
      expect(fixture.readEntry()).toBeUndefined();
      expect(fixture.readBinding()).toBeUndefined();
    });
  },
);

it("rejects host deletion of a stale Codex binding generation", async () => {
  await withNativeBindingFixture("codex", async (fixture) => {
    const entry = fixture.readEntry();
    const successor = { ...fixture.readBinding(), sessionId: "new-generation" };
    fixture.bindingStore.register(fixture.bindingKey, successor);
    await expect(fixture.remove()).rejects.toThrow("generation changed");
    expect(fixture.readEntry()).toEqual(entry);
    expect(fixture.readBinding()).toEqual(successor);
  });
});

it("uses each installed plugin owner's packaged codec during real binding deletion", async () => {
  await withNativeBindingFixture("codex", async (fixture) => {
    const entry = fixture.readEntry();
    const binding = fixture.readBinding();
    for (const generation of ["first", "second"]) {
      const rootDir = path.join(path.dirname(fixture.database.path), `installed-${generation}`);
      mkdirSync(path.join(rootDir, "dist"), { recursive: true });
      writeFileSync(path.join(rootDir, "package.json"), '{"type":"module"}');
      const message = `synthetic installed ${generation} codec refusal`;
      writeFileSync(
        path.join(rootDir, "dist", "native-session-binding-api.js"),
        `export function readNativeSessionBindingRecord() { throw new Error(${JSON.stringify(message)}); }`,
      );
      Object.assign(fixture.registry.plugins[0]!, {
        rootDir,
        source: path.join(rootDir, "dist", "index.js"),
        origin: "global",
      });
      await expect(fixture.remove()).rejects.toMatchObject({
        code: "PLUGIN_STATE_WRITE_FAILED",
        cause: { message },
      });
      expect(fixture.readEntry()).toEqual(entry);
      expect(fixture.readBinding()).toEqual(binding);
    }
  });
});

it("keeps archive bytes and identity publication equivalent to the released native adapter", async () => {
  const outcomes: unknown[] = [];
  const hostBindingSql = { native: 0, worker: 0 };
  for (const mode of ["native", "worker"] as const) {
    await withNativeBindingFixture(
      "codex",
      async (fixture) => {
        const notifications: unknown[] = [];
        const unsubscribe = onSessionIdentityMutation((event) => {
          if (
            event.kind === "delete" &&
            event.previous.sessionKeys.includes(fixture.scope.sessionKey)
          ) {
            notifications.push({ kind: event.kind, previous: event.previous });
          }
        });
        const sql = observeHostDataSql();
        try {
          const result = await fixture.remove({ archiveTranscript: true });
          hostBindingSql[mode] = bindingWrites(sql.queries).length;
          if (mode === "native") {
            expect(hostBindingSql[mode]).toBeGreaterThan(0);
          } else {
            expect(hostBindingSql[mode]).toBe(0);
          }
          expect(result.deleted).toBe(true);
          expect(result.archivedTranscripts).toHaveLength(1);
          const bytes = readSessionArchiveContentSync(result.archivedTranscripts[0]!.archivedPath);
          expect(
            bytes
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line)),
          ).toEqual(fixture.events);
          outcomes.push({
            bytes,
            notifications,
            entry: fixture.readEntry(),
            binding: fixture.readBinding(),
          });
        } finally {
          sql.restore();
          unsubscribe();
        }
      },
      mode,
    );
  }
  console.info(
    `Native binding caller SQL: ${hostBindingSql.native} before -> ${hostBindingSql.worker} after`,
  );
  expect(outcomes[1]).toEqual(outcomes[0]);
});

it("restores the exact removed Codex row after A fails", async () => {
  await withNativeBindingFixture("codex", async (fixture) => {
    const before = fixture.readEntry();
    const failure = new Error("synthetic agent COMMIT refusal");
    let removed: Record<string, unknown> | undefined;
    let restored: Record<string, unknown> | undefined;
    let agentCommit = false;
    let fixtureWrite = false;
    observeNativeGrants((request, facts) => {
      if (facts.kind === "native-binding-ready") {
        removed = { ...fixture.readBinding(), ignoredByCodec: { keep: ["exact", 7] } };
        fixtureWrite = true;
        try {
          fixture.bindingStore.register(fixture.bindingKey, removed);
        } finally {
          fixtureWrite = false;
        }
      }
      if (request.stage === "commit" && facts.kind === "session-native-binding") {
        agentCommit = true;
        expect(fixture.readBinding()).toBeUndefined();
        throw failure;
      }
    });
    delivery.afterExecution = () => {
      restored = fixture.readBinding();
    };
    const measured: string[] = [];
    const sql = observeHostDataSql((query) => {
      if (!fixtureWrite) {
        measured.push(query);
      }
    });
    try {
      const rejected = fixture.remove();
      await expect(rejected).rejects.toBe(failure);
      expect(agentCommit).toBe(true);
      // Exclude only this test's explicit before-image write, not the owner's restoration.
      expect(bindingWrites(measured)).toEqual([]);
    } finally {
      sql.restore();
    }
    expect(fixture.readEntry()).toEqual(before);
    expect(removed).toBeDefined();
    expect(restored).toMatchObject({
      ...removed,
      lease: {
        token: isRecord(removed?.lease) ? removed.lease.token : undefined,
        expiresAt: expect.any(Number),
      },
    });
    const { lease: originalLease, ...originalValue } = removed!;
    const { lease: restoredLease, ...restoredValue } = restored!;
    expect(restoredValue).toEqual(originalValue);
    expect(
      isRecord(restoredLease) &&
        isRecord(originalLease) &&
        typeof restoredLease.expiresAt === "number" &&
        typeof originalLease.expiresAt === "number" &&
        restoredLease.expiresAt >= originalLease.expiresAt,
    ).toBe(true);
  });
});

it.each(["absent", "expired lease"] as const)(
  "rechecks the %s predicate inside the executing worker before deleting the binding",
  async (condition) => {
    await withNativeBindingFixture("agentsapi", async (fixture) => {
      const before = fixture.readEntry();
      const binding = fixture.readBinding();
      expect(binding).toBeDefined();
      if (condition === "absent") {
        fixture.bindingStore.delete(fixture.bindingKey);
      }
      let checked = false;
      let current: Record<string, unknown> | undefined;
      observeNativeGrants((_request, facts) => {
        if (facts.kind !== "native-binding-ready" || checked) {
          return;
        }
        checked = true;
        const held = fixture.readBinding();
        current =
          condition === "absent"
            ? { ...binding, sessionId: "successor-created-after-preparation" }
            : { ...held, lease: { ...(isRecord(held?.lease) ? held.lease : {}), expiresAt: 1 } };
        fixture.bindingStore.register(fixture.bindingKey, current);
      });
      await expect(fixture.remove()).rejects.toThrow("binding changed before session deletion");
      expect(checked).toBe(true);
      expect(fixture.readEntry()).toEqual(before);
      if (condition === "absent") {
        expect(fixture.readBinding()).toEqual(current);
      } else {
        // Normal lease release may remove the expired lease after the veto; the native value survives.
        expect(fixture.readBinding()).toMatchObject(binding!);
      }
    });
  },
);

it.each([false, true])(
  "settles ACP's commit-only finalizer from acknowledged A outcome (rollback: %s)",
  async (rollback) => {
    await withNativeBindingFixture("agentsapi", async (fixture) => {
      fixture.bindingStore.delete(fixture.bindingKey);
      const finalized = vi.fn();
      const rolledBack = vi.fn();
      fixture.harness.withSessionDeletion = (_params, run) =>
        run(
          createNativeSessionCommitFinalizer({
            commit: finalized,
            rollback: rolledBack,
          }),
        );
      const before = fixture.readEntry();
      const failure = new Error("synthetic ACP agent COMMIT refusal");
      let commitSeen = false;
      observeNativeGrants((request, facts) => {
        if (request.stage !== "commit" || facts.kind !== "session-native-binding") {
          return;
        }
        commitSeen = true;
        expect(finalized).not.toHaveBeenCalled();
        if (rollback) {
          throw failure;
        }
      });
      if (rollback) {
        await expect(fixture.remove()).rejects.toBe(failure);
      } else {
        await expect(fixture.remove()).resolves.toMatchObject({ deleted: true });
      }
      expect(commitSeen).toBe(true);
      expect(finalized).toHaveBeenCalledTimes(rollback ? 0 : 1);
      expect(rolledBack).toHaveBeenCalledTimes(rollback ? 1 : 0);
      expect(fixture.readEntry()).toEqual(rollback ? before : undefined);
    });
  },
);

it.each([false, true])(
  "settles a shipped Agents API binding in the worker (rollback: %s)",
  async (rollback) => {
    await withNativeBindingFixture("agentsapi", async (fixture) => {
      const legacy = {
        sessionId: "synthetic-agentsapi-session",
        authFingerprint: "3c26b68488ce497a69d2c9fce9ee19c461fa67a3d959b0dc3bafe5718c56119d",
      };
      fixture.bindingStore.register(fixture.bindingKey, legacy);
      const before = fixture.readEntry();
      const failure = new Error("synthetic legacy deletion COMMIT refusal");
      let commitSeen = false;
      observeNativeGrants((request, facts) => {
        if (request.stage === "commit" && facts.kind === "session-native-binding") {
          commitSeen = true;
          expect(fixture.readBinding()).toBeUndefined();
          if (rollback) {
            throw failure;
          }
        }
      });
      const sql = observeHostDataSql();
      try {
        if (rollback) {
          await expect(fixture.remove()).rejects.toBe(failure);
        } else {
          await expect(fixture.remove()).resolves.toMatchObject({ deleted: true });
        }
        expect(commitSeen).toBe(true);
        expect(bindingWrites(sql.queries)).toEqual([]);
        expect(fixture.readBinding()).toEqual(rollback ? legacy : undefined);
        expect(fixture.readEntry()).toEqual(rollback ? before : undefined);
      } finally {
        sql.restore();
      }
    });
  },
);
