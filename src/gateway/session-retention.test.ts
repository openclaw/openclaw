import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { ready } from "./session-row-projection-record.js";
import { withAcceptedSuffix } from "./session-row-projection.accepted-facts.test-support.js";
import {
  createTestProjection,
  holdForeground,
  seedRow as writeEntry,
} from "./session-row-projection.read-fixture.test-support.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";
import { listProjectedSessions, prepareSessionRowSelection } from "./session-utils-list.js";

const weak = (value: object) => new WeakRef(value);
async function expectCollected(refs: WeakRef<object>[]) {
  // End the WeakRef creation job; dereferencing before GC would keep targets alive.
  await nextTurn();
  queryObjects(WeakRef);
  for (const ref of refs) {
    expect(ref.deref()).toBeUndefined();
  }
}

const unavailableMessage =
  "Session access facts are unavailable; retry after session storage is ready.";

it("collects superseded resident rows and their materializations after metadata refreshes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const keys = Array.from({ length: 4 }, (_, index) => `agent:main:retention-${index}`);
    const write = (key: string, revision: number) =>
      writeEntry(key, {
        sessionId: key,
        updatedAt: revision + 1,
        label: `Revision ${revision}`,
        lastRunError: `${key}: ${"synthetic error ".repeat(2_048)}`,
      });
    for (const key of keys) {
      write(key, 0);
    }
    // Optional transcript work must not borrow a row while collection is measured.
    const release = holdForeground();
    const projection = await createTestProjection({ cfg, modelCatalog: [] });
    const rows = () => projection.selectEntries().filter(ready);
    const retired: WeakRef<object>[] = [];
    const selections: WeakRef<object>[] = [];
    const snapshots: WeakRef<object>[] = [];
    function captureSelections() {
      for (const opts of [{}, { agentId: "main" }, { configuredAgentsOnly: true }]) {
        for (const activeOnly of [false, true]) {
          selections.push(
            ...prepareSessionRowSelection(projection, { ...opts, activeOnly }, { ordered: true })
              .entries("all")
              .map(weak),
          );
        }
      }
    }
    const control = weak({});
    function refreshEntries(revision: number) {
      for (const row of rows()) {
        retired.push(...[row, row.entry, row.materialized].map(weak));
        write(row.key, revision);
      }
    }
    async function captureList(revision: number) {
      const result = await listProjectedSessions({
        projection,
        opts: { limit: keys.length, includePeople: true },
        acceptsSerializedJson: true,
      });
      snapshots.push(...result.sessions.map(weak));
      expect(result.sessions.map((row) => row.label)).toEqual(
        keys.map(() => `Revision ${revision}`),
      );
    }
    try {
      await projection.ensureMaterialized();
      await captureList(0);
      for (let revision = 1; revision <= 4; revision++) {
        refreshEntries(revision);
        await projection.ensureMaterialized();
        await captureList(revision);
        captureSelections();
      }
      // A publication must release the last list even when no subsequent viewer arrives.
      refreshEntries(5);
      await projection.ensureMaterialized();
      await expectCollected([control, ...retired, ...selections, ...snapshots]);
      expect(rows()).toHaveLength(keys.length);
      await listProjectedSessions({ projection, opts: {}, acceptsSerializedJson: true });
      const materializations = rows().map((row) => weak(row.materialized));
      // An unchanged catalog refresh preserves the current materializations until disposal.
      sessionChanges.emit({ all: true, scope: "catalog" });
      await projection.ensureMaterialized();
      rows().forEach((row, index) => {
        expect(row.materialized).toBe(materializations[index]!.deref());
      });
      await listProjectedSessions({ projection, opts: {}, acceptsSerializedJson: true });
      const disposedEntries = projection.selectEntries().map((row) => weak(row.entry));
      captureSelections();
      projection.dispose();
      await expectCollected([...materializations, ...disposedEntries, ...selections]);
    } finally {
      projection.dispose();
      release();
      await nextTurn();
    }
  });
});

it("does not retain a superseded child entry through a held parent display row", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const parent = "agent:main:compact-parent";
    const child = "agent:main:compact-child";
    writeEntry(parent, { sessionId: "compact-parent", updatedAt: 1 });
    const writeChild = (updatedAt: number) =>
      writeEntry(child, { sessionId: "compact-child", updatedAt, parentSessionKey: parent });
    writeChild(1);
    using _ = holdForeground();
    using projection = await createTestProjection({ cfg, modelCatalog: [] });
    await projection.ensureMaterialized();
    const heldParent = projection.describe({ agentId: "main", key: parent })!;
    const retiredChild = new WeakRef(projection.describe({ agentId: "main", key: child })!.entry);
    writeChild(2);
    await projection.ensureMaterialized();
    await expectCollected([retiredChild]);
    // Retained consumers may still hold the old parent; it needs only child display facts.
    expect(heldParent.materialized.source.childLinks?.[0]?.entry.sessionId).toBe("compact-child");
    expect(
      projection.snapshot({ agentId: "main", key: parent }, { now: 2 }).row?.childSessions,
    ).toEqual([child]);
  });
});

it("does not render the accepted suffix after dispose", async () => {
  const refs: WeakRef<object>[] = [];
  await withAcceptedSuffix(async ({ projection, suffix, query, resume }) => {
    const pending = weak(suffix.pendingDatabaseFacts!);
    refs.push(weak({}), pending);
    projection.dispose();
    await resume();
    expect(projection.isCurrent(suffix)).toBe(false);
    expect(projection.snapshot(query).row?.label ?? null).toBe(null);
  });
  // Restoring spies does not clear their recorded fixture arguments or results.
  vi.clearAllMocks();
  await expectCollected(refs);
});

it("does not retain discovery context in active session authority", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    const sessionKey = "agent:main:retention";
    const target = { agentId: "main", sessionKey };
    const prepare = () => prepareSessionMutationFacts({ cfg, ...target });
    replaceSessionEntrySync(target, { sessionId: "retention", updatedAt: 1 });
    (await prepare()).release();
    const scope = new AsyncLocalStorage<object>();
    async function capture() {
      const payload = { sessions: [{ sessionId: "completed-unrelated-session" }] };
      const facts = await scope.run(payload, prepare);
      return { facts, payload: weak(payload), control: weak({}) };
    }
    const retained = await capture();
    try {
      await expectCollected([retained.control, retained.payload]);
      expect(retained.facts.readCurrent(cfg).target.entry.sessionId).toBe("retention");
      retained.facts.release();
      expect(() => retained.facts.readCurrent(cfg)).toThrow(unavailableMessage);
    } finally {
      retained.facts.release();
      scope.disable();
    }
  }));
