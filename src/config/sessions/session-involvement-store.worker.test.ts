import { expect, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { SessionMutationAuthorizationChangedError } from "../../gateway/session-mutation-authorization-error.js";
import {
  SqliteWorkerError,
  type SqliteWorkerOperations,
} from "../../infra/sqlite-worker-contract.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { onSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import { sessionChanges, type SessionRowChange } from "../../sessions/session-row-changes.js";
import * as agentWorkers from "../../state/openclaw-agent-worker-store.js";
import { linkEmail } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { loadSessionEntry, replaceSessionEntrySync } from "./session-accessor.js";
import { updateSessionProfileInvolvementAsync } from "./session-involvement-store.js";
import { it } from "./session-worker-state.test-support.js";

function createFixture(canonicalGeneration?: string) {
  const scope = { agentId: "main", sessionKey: "agent:main:involvement-worker" };
  const sessionId = "involvement-worker";
  const firstEmail = "current@involvement.example.test";
  const secondEmail = "previous@involvement.example.test";
  const first = ensureProfileForEmail(firstEmail);
  const second = ensureProfileForEmail(secondEmail);
  const [profile, previous, previousEmail] =
    first.id < second.id ? [second, first, firstEmail] : [first, second, secondEmail];
  const source = { generation: "involvement-generation", sequence: 1, timestamp: 1 };
  const mention = (lastMention = source) => ({ hidden: false, updatedAt: 1, lastMention });
  replaceSessionEntrySync(scope, {
    sessionId,
    updatedAt: 1,
    profileInvolvement: {
      key: scope.sessionKey,
      profiles: {
        [previous.id]: mention(),
        ...(canonicalGeneration
          ? { [profile.id]: mention({ ...source, generation: canonicalGeneration }) }
          : {}),
      },
    },
  });
  return {
    scope,
    profile,
    previousEmail,
    source,
    update: (
      change: Parameters<typeof updateSessionProfileInvolvementAsync>[1]["change"],
      assertCurrent?: () => void,
    ) =>
      updateSessionProfileInvolvementAsync(scope, {
        expectedSessionId: sessionId,
        profileIds: [profile.id],
        change,
        assertCurrent,
      }),
    read: () => loadSessionEntry(scope)?.profileInvolvement?.profiles,
  };
}

it("serializes merged-profile mention and visibility writes without caller-thread entry or alias SQL", async () => {
  const f = createFixture("canonical-generation");
  const canonicalSource = { ...f.source, generation: "canonical-generation" };
  expect(f.read()?.[f.profile.id]?.lastMention).toEqual(canonicalSource);
  linkEmail(f.previousEmail, f.profile.id);
  const next = { ...canonicalSource, sequence: 2 };
  const sql = observeHostDataSql();
  try {
    expect(
      await Promise.all([
        f.update({ kind: "mention", source: next }),
        f.update({ kind: "visibility", hidden: true }),
        f.update({ kind: "mention", source: canonicalSource }),
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

it.each(["transaction", "commit"] as const)(
  "rolls back involvement when host authority is revoked at %s and preserves the error identity",
  async (stage) => {
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
      const result = await f
        .update({ kind: "visibility", hidden: true }, () => {
          if (!current) {
            throw failure;
          }
        })
        .catch((error: unknown) => error);
      expect(revoked).toBe(true);
      expect(result).toBe(failure);
      expect(f.read()).toEqual(before);
    } finally {
      observe.mockRestore();
    }
  },
);

it("publishes a committed involvement receipt when the ordinary reply is lost without replay", async () => {
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
      async <Operations extends SqliteWorkerOperations>(
        ...args: Parameters<typeof original>
      ): Promise<agentWorkers.OpenClawAgentSqliteWorkerStore<Operations>> => {
        const worker = await original<Operations>(...args);
        return {
          ...worker,
          run(consume, assertCurrent) {
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
    await expect(f.update({ kind: "mention", source: f.source })).resolves.toBe(true);
    expect(changes).toEqual([
      expect.objectContaining({
        sessionKey: f.scope.sessionKey,
        facts: { kind: "unchanged" },
      }),
    ]);
    expect(lifecycle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionKey: f.scope.sessionKey, reason: "involvement" }),
    );
    expect(f.read()?.[f.profile.id]).toMatchObject({ hidden: false, lastMention: f.source });
    expect(dispatches).toBe(1);
  } finally {
    open.mockRestore();
    stopChanges();
    stopLifecycle();
  }
});
