import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import * as history from "../../config/sessions/session-transcript-worker-runtime.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as databases from "../../state/openclaw-agent-db-lifecycle.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import {
  initializeSessionReadContext,
  requestContext,
} from "./sessions-read-cache.test-support.js";

afterEach(() => vi.restoreAllMocks());

it("settles the fixture projection before releasing its session history database", async () => {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const cleanup = createDeferredCore();
  let preparing: Promise<void> | undefined;
  const close = databases.closeOpenClawAgentDatabasesAsync;
  vi.spyOn(databases, "closeOpenClawAgentDatabasesAsync").mockImplementation((root) => {
    cleanup.resolve();
    return close(root);
  });
  const fixture = withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = { agentId: "main", sessionKey: "agent:main:fixture-read" };
    await upsertSessionEntryCore(scope, { sessionId: "fixture-read", updatedAt: 1 });
    const context = requestContext({});
    await initializeSessionReadContext(context);
    const projection = expectDefined(getSessionRowProjection(context), "fixture projection");
    await projection.ensureMaterialized();
    const dispose = projection.dispose;
    vi.spyOn(projection, "dispose").mockImplementation(() => {
      cleanup.resolve();
      dispose();
    });
    const read = history.withSessionHistoryWorkerDatabases;
    let held = false;
    vi.spyOn(history, "withSessionHistoryWorkerDatabases").mockImplementation(
      (targets, consume, lane) =>
        read(
          targets,
          async (owners) => {
            const result = await consume(owners);
            if (!held) {
              held = true;
              entered.resolve();
              await release.promise;
            }
            return result;
          },
          lane,
        ),
    );
    sessionChanges.emit({ all: true, scope: { agentId: "main" }, factsInvalidated: true });
    preparing = projection.ensureMaterialized();
    void preparing.catch(() => {});
    await Promise.race([
      entered.promise,
      preparing.then(() => {
        throw new Error("Projection did not retain a history read");
      }),
    ]);
  });
  void fixture.catch(() => {});
  try {
    await Promise.race([
      cleanup.promise,
      fixture.then(() => {
        throw new Error("Fixture completed without releasing its resources");
      }),
    ]);
    release.resolve();
    await expect(preparing).resolves.toBeUndefined();
    await fixture;
  } finally {
    release.resolve();
    await Promise.allSettled([preparing, fixture]);
  }
});
