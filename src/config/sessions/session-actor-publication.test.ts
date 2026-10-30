import { expect, it, vi } from "vitest";
import { appendSessionManagerActor } from "../../agents/sessions/session-manager-actor-append.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { observeSessionEntryMaintenanceAgeChanges } from "./session-accessor.sqlite-maintenance-age.js";
import { createSessionActorFactory } from "./session-actor-durable.js";

// mock-isolation: this publication proof does not schedule unrelated maintenance.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: keep background disk-budget eviction outside the transport proof.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

it.each([
  { agentId: "main", sessionKey: "agent:main:actor-first-maintenance", databaseAgentId: "main" },
  {
    agentId: "secondary",
    sessionKey: "agent:secondary:actor-first-maintenance",
    databaseAgentId: "main",
  },
  { agentId: "secondary", sessionKey: "global", databaseAgentId: "secondary" },
])(
  "publishes $agentId actor initialization for $sessionKey in a shared store",
  async ({ agentId, sessionKey, databaseAgentId }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env, statePath }) => {
      const database = openOpenClawAgentDatabase({
        agentId: databaseAgentId,
        path: statePath("shared.sqlite"),
      });
      const identity = readOpenClawAgentDatabaseIdentity(database);
      if (typeof identity.identity !== "string") {
        throw new Error("Fixture requires durable storage");
      }
      const scope = {
        agentId,
        storePath: database.path,
        sessionKey,
        sessionId: "actor-first-maintenance",
      };
      const actor = await createSessionActorFactory({
        agentId: databaseAgentId,
        path: database.path,
        env,
      }).acquire(
        {
          sessionKey: scope.sessionKey,
          database: {
            kind: "file",
            physicalIdentity: identity.identity,
            birthtime: identity.birthtime,
            nativeLocation: database.path,
          },
        },
        { assertCurrent() {}, assertReadable() {} },
      );
      const rowChanges = vi.fn();
      const stopRowChanges = sessionChanges.subscribe(rowChanges);
      const ageChanges = vi.fn();
      const stopAgeChanges = observeSessionEntryMaintenanceAgeChanges(
        identity.identity,
        ageChanges,
      );
      try {
        const result = await appendSessionManagerActor({
          actor,
          toolResult: false,
          message: { role: "user" },
          assertCurrent() {},
          append: {
            kind: "message",
            input: {
              scope,
              cwd: "/synthetic",
              messageJson: JSON.stringify({ role: "user", content: "first input", timestamp: 2 }),
            },
            initialization: { scope, entry: { sessionId: scope.sessionId, updatedAt: 2 } },
          },
        });
        expect(result.failure).toBeUndefined();
        expect(result.committed).toMatchObject({
          kind: "message",
          value: { snapshot: { ok: true } },
        });
        expect(rowChanges).toHaveBeenCalledWith(expect.objectContaining({ agentId, sessionKey }));
        expect(ageChanges).toHaveBeenCalledExactlyOnceWith({
          sessionKey: scope.sessionKey,
          entry: expect.objectContaining({ sessionId: scope.sessionId }),
          previousEntry: undefined,
        });
      } finally {
        stopAgeChanges();
        stopRowChanges();
        await actor.release();
      }
    });
  },
);
