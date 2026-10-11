import { expect, it, vi } from "vitest";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db-registry.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { prepareSessionGenerationFacts } from "./session-delivery-generation.js";
import * as entryReads from "./session-entry-read-runtime.js";

it.each([
  ...(
    [
      "same",
      "unrelated",
      "remove",
      "reassignment",
      "ABA",
      "unknown",
      "unwitnessed",
      "rollback",
    ] as const
  ).map((change) => ({ change, location: "shared" })),
  ...(
    [
      "same",
      "unrelated",
      "remove",
      "reassignment",
      "ABA",
      "unknown",
      "unwitnessed",
      "rollback",
    ] as const
  ).map((change) => ({
    change,
    location: "canonical",
  })),
])(
  "retains only unchanged $location sharing sources after a $change registry publication",
  async ({ change, location }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const canonical = location === "canonical";
      const storePath = canonical
        ? resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env })
        : state.statePath("shared.sqlite");
      const registration = { agentId: "main", path: storePath, env: state.env };
      openOpenClawAgentDatabase(registration);
      const agentId = canonical ? "main" : "ops";
      const target = { agentId, sessionKey: `agent:${agentId}:registry-sharing` };
      replaceSessionEntrySync(
        { ...target, storePath },
        {
          sessionId: "registry-sharing",
          lifecycleRevision: "first",
          updatedAt: 1,
        },
      );
      const prepared = await prepareSessionGenerationFacts({
        ...target,
        storePath,
        sessionId: "registry-sharing",
        lifecycleRevision: "first",
      });
      try {
        if (change === "unknown") {
          sessionChanges.emit({ all: true, scope: "stores" });
        } else if (change === "unwitnessed") {
          sessionChanges.emit({ all: true, scope: { agentId: "neighbor", topology: true } });
        } else if (change === "unrelated") {
          openOpenClawAgentDatabase({ agentId: "neighbor", env: state.env });
        } else if (change === "same") {
          registerOpenClawAgentDatabase(registration);
        } else if (change === "rollback") {
          expect(() =>
            runOpenClawStateWriteTransaction(
              () => {
                unregisterOpenClawAgentDatabase(registration);
                // A pending mutation must fail closed even before its public notification.
                expect(prepared.assertCurrent).toThrow();
                expect(prepared.prepareRead).toThrow();
                throw new Error("Synthetic registry rollback");
              },
              { env: state.env },
            ),
          ).toThrow("Synthetic registry rollback");
        } else if (change === "reassignment") {
          registerOpenClawAgentDatabase({ ...registration, agentId: "other" });
        } else {
          unregisterOpenClawAgentDatabase(registration);
          if (change === "ABA") {
            registerOpenClawAgentDatabase(registration);
          }
        }
        if (change === "same" || change === "unrelated" || change === "rollback") {
          prepared.assertCurrent();
          expect(prepared.prepareRead()).toBeUndefined();
        } else {
          expect(prepared.assertCurrent).toThrow();
          expect(prepared.prepareRead).toThrow();
          openOpenClawAgentDatabase({ agentId: "unrelated-after-revocation", env: state.env });
          expect(prepared.assertCurrent).toThrow();
        }
      } finally {
        prepared.release();
      }
    });
  },
);

it.each(["unrelated", "sibling"] as const)(
  "keeps legacy discovery scoped across %s registration",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const path = state.statePath("custom.sqlite");
      const target = {
        agentId: "main",
        storePath: state.statePath("custom.json"),
        sessionKey: "agent:main:legacy",
      };
      openOpenClawAgentDatabase({ agentId: "main", path, env: state.env });
      const entry = { sessionId: "legacy", lifecycleRevision: "first", updatedAt: 1 };
      replaceSessionEntrySync(target, entry);
      const prepared = await prepareSessionGenerationFacts({ ...target, ...entry });
      try {
        prepared.assertCurrent();
        openOpenClawAgentDatabase({
          agentId: "neighbor",
          path: state.statePath(
            change === "sibling" ? "custom.neighbor.sqlite" : "unrelated.sqlite",
          ),
          env: state.env,
        });
        if (change === "sibling") {
          expect(prepared.assertCurrent).toThrow();
        } else {
          prepared.assertCurrent();
          expect(prepared.prepareRead()).toBeUndefined();
        }
      } finally {
        prepared.release();
      }
    });
  },
);

it.each(["unrelated", "remove", "reassignment", "ABA"] as const)(
  "fences %s registry publication during generation preparation",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const registration = { agentId: "main", env: state.env };
      const database = openOpenClawAgentDatabase(registration);
      const scope = {
        agentId: "main",
        storePath: database.path,
        sessionKey: "agent:main:preparing",
      };
      const original = { sessionId: "preparing", lifecycleRevision: "first", updatedAt: 1 };
      replaceSessionEntrySync(scope, original);
      const originalRead = entryReads.withSessionEntriesFromStoresInWorker;
      // The real worker has read its rows; publish before the generation selects that source.
      const read = vi
        .spyOn(entryReads, "withSessionEntriesFromStoresInWorker")
        .mockImplementation((inputs, consume, options) =>
          originalRead(
            inputs,
            (rows) => {
              if (change === "unrelated") {
                openOpenClawAgentDatabase({ agentId: "neighbor", env: state.env });
              } else if (change === "reassignment") {
                registerOpenClawAgentDatabase({
                  agentId: "other",
                  path: database.path,
                  env: state.env,
                });
              } else {
                unregisterOpenClawAgentDatabase({ ...registration, path: database.path });
                if (change === "ABA") {
                  registerOpenClawAgentDatabase({ ...registration, path: database.path });
                }
              }
              return consume(rows);
            },
            options,
          ),
        );
      try {
        const prepared = prepareSessionGenerationFacts({ ...scope, ...original });
        if (change === "unrelated") {
          const lease = await prepared;
          try {
            lease.assertCurrent();
          } finally {
            lease.release();
          }
        } else {
          await expect(prepared).rejects.toThrow();
        }
      } finally {
        read.mockRestore();
      }
    });
  },
);
