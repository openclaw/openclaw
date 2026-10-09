import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { SessionMutationAuthorizationChangedError } from "../../gateway/session-mutation-authorization-error.js";
import {
  SqliteWorkerError,
  type SqliteWorkerOperations,
  type SqliteWorkerStore,
} from "../../infra/sqlite-worker-contract.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { onSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import { sessionChanges, type SessionRowChange } from "../../sessions/session-row-changes.js";
import * as agentWorkers from "../../state/openclaw-agent-worker-store.js";
import { linkEmail } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { loadSessionEntry, replaceSessionEntrySync } from "./session-accessor.js";
import { updateSessionProfileInvolvementAsync } from "./session-involvement-store.js";

function createFixture(canonicalGeneration?: string) {
  const scope = { agentId: "main", sessionKey: "agent:main:involvement-worker" };
  const sessionId = "involvement-worker";
  const firstEmail = "current@involvement.example.test";
  const secondEmail = "previous@involvement.example.test";
  const first = ensureProfileForEmail(firstEmail);
  const second = ensureProfileForEmail(secondEmail);
  const firstIsAlias = first.id < second.id;
  const profile = firstIsAlias ? second : first;
  const previous = firstIsAlias ? first : second;
  const previousEmail = firstIsAlias ? firstEmail : secondEmail;
  const source = { generation: "involvement-generation", sequence: 1, timestamp: 1 };
  replaceSessionEntrySync(scope, {
    sessionId,
    updatedAt: 1,
    profileInvolvement: {
      key: scope.sessionKey,
      profiles: {
        [previous.id]: { hidden: false, updatedAt: 1, lastMention: source },
        ...(canonicalGeneration
          ? {
              [profile.id]: {
                hidden: false,
                updatedAt: 1,
                lastMention: { ...source, generation: canonicalGeneration },
              },
            }
          : {}),
      },
    },
  });
  return {
    scope,
    profile,
    previous,
    previousEmail,
    source,
    params: { expectedSessionId: sessionId, profileIds: [profile.id] },
    read: () => loadSessionEntry(scope)?.profileInvolvement?.profiles,
  };
}

it("serializes merged-profile mention and visibility writes without caller-thread entry or alias SQL", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = createFixture("canonical-generation");
    const canonicalSource = { ...f.source, generation: "canonical-generation" };
    expect(f.read()?.[f.profile.id]?.lastMention).toEqual(canonicalSource);
    linkEmail(f.previousEmail, f.profile.id);
    const next = { ...canonicalSource, sequence: 2 };
    const sql = observeHostDataSql();
    try {
      expect(
        await Promise.all([
          updateSessionProfileInvolvementAsync(f.scope, {
            ...f.params,
            change: { kind: "mention", source: next },
          }),
          updateSessionProfileInvolvementAsync(f.scope, {
            ...f.params,
            change: { kind: "visibility", hidden: true },
          }),
          updateSessionProfileInvolvementAsync(f.scope, {
            ...f.params,
            change: { kind: "mention", source: canonicalSource },
          }),
        ]),
      ).toEqual([true, true, true]);
      expect(
        sql.queries.filter((query) =>
          /\b(?:session_nodes|user_profiles|user_profile_emails)\b/i.test(query),
        ),
      ).toEqual([]);
    } finally {
      sql.restore();
    }
    expect(f.read()).toEqual({
      [f.profile.id]: { hidden: true, updatedAt: expect.any(Number), lastMention: next },
    });
  });
});

it.each(["transaction", "commit"] as const)(
  "rolls back involvement when host authority is revoked at %s and preserves the error identity",
  async (stage) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = createFixture();
      const before = f.read();
      const failure = new SessionMutationAuthorizationChangedError({
        code: "FORBIDDEN",
        message: "Involvement authority revoked",
      });
      let current = true;
      let revoked = false;
      const observe = probe.admission(admission, (request, grant, callback) => {
        if (request.stage === stage) {
          current = false;
          revoked = true;
        }
        callback(request, grant);
      });
      try {
        const result = await updateSessionProfileInvolvementAsync(f.scope, {
          ...f.params,
          change: { kind: "visibility", hidden: true },
          assertCurrent: () => {
            if (!current) {
              throw failure;
            }
          },
        }).catch((error: unknown) => error);
        expect(revoked).toBe(true);
        expect(result).toBe(failure);
        expect(result).toBeInstanceOf(SessionMutationAuthorizationChangedError);
        expect(f.read()).toEqual(before);
      } finally {
        observe.mockRestore();
      }
    });
  },
);

it("rejects a profile alias merge between involvement preparation and commit", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = createFixture();
    const before = f.read();
    let merged = false;
    const observe = probe.admission(admission, (request, grant, callback) => {
      if (request.stage === "commit" && !merged) {
        merged = true;
        linkEmail(f.previousEmail, f.profile.id);
      }
      callback(request, grant);
    });
    try {
      await expect(
        updateSessionProfileInvolvementAsync(f.scope, {
          ...f.params,
          change: { kind: "visibility", hidden: true },
        }),
      ).rejects.toThrow("Session involvement profile aliases changed before commit");
      expect(merged).toBe(true);
      expect(f.read()).toEqual(before);
    } finally {
      observe.mockRestore();
    }
  });
});

it("invalidates an unknown involvement commit without replay or acknowledged lifecycle publication", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = createFixture();
    expect(f.read()).not.toHaveProperty(f.profile.id);
    const changes: SessionRowChange[] = [];
    const stopChanges = sessionChanges.subscribeFacts((change) => changes.push(change));
    const lifecycle = vi.fn();
    const stopLifecycle = onSessionLifecycleEvent((event) => {
      if (event.sessionKey === f.scope.sessionKey && event.reason === "involvement") {
        lifecycle(event);
      }
    });
    const failure = new SqliteWorkerError("Involvement commit reply lost", "outcome-unknown");
    const original = agentWorkers.openOpenClawAgentSqliteWorkerStore;
    let dispatches = 0;
    const open = vi
      .spyOn(agentWorkers, "openOpenClawAgentSqliteWorkerStore")
      .mockImplementation(
        async <Operations extends SqliteWorkerOperations>(...args: Parameters<typeof original>) => {
          const worker = await original<Operations>(...args);
          return {
            ...worker,
            run<T>(
              consume: (operation: Pick<SqliteWorkerStore<Operations>, "execute">) => Promise<T>,
              assertCurrent: () => void,
            ) {
              return worker.run(
                (operation) =>
                  consume({
                    async execute(command, options) {
                      if (command.type === "involvement") {
                        dispatches++;
                      }
                      const result = await operation.execute(command, options);
                      if (command.type === "involvement") {
                        throw failure;
                      }
                      return result;
                    },
                  }),
                assertCurrent,
              );
            },
          };
        },
      );
    try {
      await expect(
        updateSessionProfileInvolvementAsync(f.scope, {
          ...f.params,
          change: { kind: "mention", source: f.source },
        }),
      ).rejects.toBe(failure);
      expect(dispatches).toBe(1);
      expect(changes).toEqual([
        expect.objectContaining({ sessionKey: f.scope.sessionKey, factsInvalidated: true }),
      ]);
      expect(lifecycle).not.toHaveBeenCalled();
      expect(f.read()?.[f.profile.id]).toMatchObject({ hidden: false, lastMention: f.source });
      expect(dispatches).toBe(1);
    } finally {
      open.mockRestore();
      stopChanges();
      stopLifecycle();
    }
  });
});
