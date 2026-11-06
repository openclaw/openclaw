import { expect, test } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { loadGatewayWorkerEnvironmentStartupState } from "./server-worker-environment-startup.js";
import { loadSessionEntryAsync } from "./session-entry-load.test-support.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
import { createWorkerInferenceDrainService } from "./worker-environments/inference-control.test-helpers.js";
import { REQUEST } from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createHarness } from "./worker-environments/placement-dispatch-test-harness.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

const AUTOMATION_BASE_KEY = "agent:main:cron:one-shot-job";
const sessionId = REQUEST.sessionId;
const alias = `${AUTOMATION_BASE_KEY}:run:${sessionId}`;

async function seedSession(aliasRow = false) {
  await createSessionStoreDir();
  const entry = sessionStoreEntry(sessionId);
  await writeSessionStore({
    entries: { [AUTOMATION_BASE_KEY]: entry, ...(aliasRow ? { [alias]: entry } : {}) },
  });
}

async function seedIdleAutomationRunPlacement(placementSessionKey = alias, aliasRow = false) {
  await seedSession(aliasRow);
  const { placementStore } = await loadGatewayWorkerEnvironmentStartupState();
  const claim = await placementStore.claimTurn({
    sessionId,
    agentId: "main",
    sessionKey: placementSessionKey,
    owner: { kind: "local" },
    claimId: `${sessionId}-claim`,
    runId: `${sessionId}-run`,
  });
  await placementStore.releaseTurn(claim);
  expect(placementStore.get(sessionId)).toMatchObject({
    state: "local",
    sessionKey: placementSessionKey,
    turnClaim: null,
  });
  return placementStore;
}

async function expectDeleted(
  placementStore: Awaited<ReturnType<typeof seedIdleAutomationRunPlacement>>,
  key = AUTOMATION_BASE_KEY,
  context: Record<string, unknown> = {},
) {
  const deleted = await directSessionReq(
    "sessions.delete",
    { key },
    {
      context: { workerSessionPlacementService: placementStore, ...context },
    },
  );
  expect(deleted.ok, JSON.stringify(deleted.error)).toBe(true);
  expect(deleted.payload).toMatchObject({ deleted: true });
  expect(placementStore.get(sessionId)).toBeUndefined();
  expect((await loadSessionEntryAsync(key)).entry).toBeUndefined();
}

test.each([false, true])(
  "sessions.delete retires an idle automation placement (exact alias: %s)",
  async (exactAlias) => {
    const placementStore = await seedIdleAutomationRunPlacement(alias, exactAlias);
    await expectDeleted(placementStore, exactAlias ? alias : AUTOMATION_BASE_KEY);
  },
);

test("sessions.patch archives an automation base session over its idle run-alias placement", async () => {
  const placementStore = await seedIdleAutomationRunPlacement();

  const archived = await directSessionReq(
    "sessions.patch",
    { key: AUTOMATION_BASE_KEY, archived: true, expectedSessionId: sessionId },
    { context: { workerSessionPlacementService: placementStore } },
  );

  expect(archived.ok, JSON.stringify(archived.error)).toBe(true);
  expect((await loadSessionEntryAsync(AUTOMATION_BASE_KEY)).entry?.archivedAt).toEqual(
    expect.any(Number),
  );
  // Archive keeps cloud affinity; only deletion retires the placement.
  expect(placementStore.get(sessionId)).toMatchObject({
    state: "local",
    sessionKey: alias,
  });
});

test("sessions.delete still rejects a placement keyed to another automation's run alias", async () => {
  const foreignAlias = `agent:main:cron:other-job:run:${sessionId}`;
  const placementStore = await seedIdleAutomationRunPlacement(foreignAlias);

  const deleted = await directSessionReq(
    "sessions.delete",
    { key: AUTOMATION_BASE_KEY },
    { context: { workerSessionPlacementService: placementStore } },
  );

  expect(deleted).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
  expect(deleted.error?.message).toContain("cloud worker placement identity changed");
  expect(placementStore.get(sessionId)).toMatchObject({ sessionKey: foreignAlias });
  expect((await loadSessionEntryAsync(AUTOMATION_BASE_KEY)).entry?.sessionId).toBe(sessionId);
});

test("sessions.delete reclaims an automation's active run-alias placement before deleting", async () => {
  await seedSession();
  const { placementStore } = await loadGatewayWorkerEnvironmentStartupState();
  const harness = await createHarness(openOpenClawStateDatabase(), placementStore, {
    reconcileChanged: false,
    reconcileCommitsManifest: false,
  });
  await harness.service.dispatch({ ...REQUEST, sessionKey: alias });

  await expectDeleted(placementStore, AUTOMATION_BASE_KEY, {
    workerEnvironmentService: createWorkerInferenceDrainService(
      () => ({ drained: Promise.resolve(), hasWork: () => false, release: () => {} }),
      harness.environments,
    ),
    workerPlacementDispatchService: harness.service,
  });
  expect(harness.environments.destroy).toHaveBeenCalledOnce();
});
