import { expect, it, vi } from "vitest";
import { getSessionRowSelectionMetrics } from "../infra/gateway-work-metrics.js";
import { createMainThreadStallMonitor, runWithMainThreadTask } from "../infra/main-thread-stall.js";
import type { SessionListFilteredEntries } from "./session-list-filters.js";
import { create, identity, readSessionRowLineage } from "./session-row-projection-record.js";
import { createSessionRowProjectionRevisions } from "./session-row-projection-revisions.js";
import { createSessionRowSelection } from "./session-row-selection.js";
import { selectSessionEntries } from "./session-utils-list.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";

it("attributes retained hits and misses separately from winner revisions and view replacement", () => {
  const cfg = { agents: { entries: { main: {} } } };
  const storePath = "/synthetic/partition-metrics.sqlite";
  const context = buildSessionListRowMetadataContext({ now: 1 });
  const agents = new Set(["main"]);
  const scope = {
    path: storePath,
    paths: new Map([[storePath, 0]]),
    agentId: "main",
    configuredAgentIds: agents,
    ownerAgentIds: agents,
  };
  const selection = createSessionRowSelection(cfg, scope, false, () => context);
  const makeRow = (suffix: string, updatedAt: number) => {
    const key = `agent:main:${suffix}`;
    const entry = { sessionId: key, updatedAt };
    return {
      ...create({ key, agentId: "main", storeTarget: { agentId: "main", storePath } }),
      entry,
    };
  };
  const first = makeRow("a", 1);
  const second = makeRow("b", 2);
  selection.add(first);
  selection.add(second);
  const revisions = createSessionRowProjectionRevisions(
    new Map([first, second].map((row) => [identity(row), row])),
    new Map(),
  );
  revisions.onSelectionChange((change) => {
    if (change.kind === "row") {
      selection.change(change);
    }
  });
  const before = getSessionRowSelectionMetrics();
  const beforeTask = before.partitions.find((counter) => counter.task === "sessions.subscribe");
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const monitor = createMainThreadStallMonitor();
  const select = (retained: WeakMap<object, SessionListFilteredEntries>) =>
    runWithMainThreadTask("gateway:rpc:sessions.subscribe", () => {
      const prepared = selection.read();
      return selectSessionEntries({
        ...prepared,
        cfg,
        opts: { limit: 100 },
        now: 1,
        getTarget: prepared.get,
        getRowContext: () => context,
        retained,
      }).entries.map(([key]) => key);
    });
  try {
    const retained = new WeakMap<object, SessionListFilteredEntries>();
    expect(select(retained)).toEqual([second.key, first.key]);
    expect(select(retained)).toEqual([second.key, first.key]);
    revisions.withChangeScope("automation", () =>
      revisions.replace(first, {
        ...first,
        ...readSessionRowLineage(first, { ...first.entry }, cfg, context),
      }),
    );
    expect(select(retained)).toEqual([second.key, first.key]);
    revisions.withChangeScope("session-entry", () =>
      revisions.replace(first, { ...first, entry: { ...first.entry, updatedAt: 3 } }),
    );
    expect(select(retained)).toEqual([first.key, second.key]);
    // A discarded view misses unchanged revisions too.
    expect(select(new WeakMap())).toEqual([first.key, second.key]);
    const after = getSessionRowSelectionMetrics();
    const counter = after.partitions.find((value) => value.task === "sessions.subscribe")!;
    expect(counter.hits - (beforeTask?.hits ?? 0)).toBe(5);
    expect(counter.misses - (beforeTask?.misses ?? 0)).toBe(5);
    const revisionCount = (value: typeof after, reason: string) =>
      value.partitionRevisions.find((revision) => revision.reason === reason)?.changes ?? 0;
    expect(revisionCount(after, "metadata") - revisionCount(before, "metadata")).toBe(1);
    expect(revisionCount(after, "automation") - revisionCount(before, "automation")).toBe(0);
  } finally {
    monitor.stop();
    vi.useRealTimers();
  }
});
