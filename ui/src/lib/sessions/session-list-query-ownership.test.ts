import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { sessionsResult } from "./session-capability.test-support.ts";
import type { SessionListSnapshot } from "./session-capability.ts";
import { sessionRow } from "./session-fixtures.test-support.ts";
import { canApplySessionListSnapshot } from "./session-list-query.ts";
import { rosterReadFixture } from "./session-roster-refresh.test-support.ts";

const row = (key: string, extra: Partial<GatewaySessionRow> = {}) =>
  sessionRow(`agent:main:${key}`, { sessionId: `${key}-session`, ...extra });
it.each([
  [200, 60, true],
  [200, 59, false],
  [2, 2, true],
  [2, 1, false],
] as const)(
  "excludes owned ancestors only behind a full prefix (limit=%i, owned=%i)",
  (limit, owned, expected) => {
    const actor = (id: string) =>
      ({ type: "human", id, identity: { type: "profile", id } }) as const;
    const rows = Array.from({ length: limit }, (_, index) =>
      row(`child-${index}`, {
        sessionId: `child-${index}`,
        updatedAt: 1_000 - index,
        owner: { actor: actor(index < owned ? "viewer" : "other") },
        parentSessionKey: "agent:main:main",
      }),
    );
    const parent = row("main", { sessionId: "parent", owner: { actor: actor("viewer") } });
    const canApply = (ancestor: GatewaySessionRow) =>
      canApplySessionListSnapshot(
        { ...sessionsResult(rows, 2_000), hasMore: true, nextOffset: limit },
        {
          reason: "patch",
          session: { ...rows[0], updatedAt: 2_001 },
          ancestorSessions: [ancestor],
        },
        { agentId: "main", limit, ownerFirst: true },
        "updatedAt",
        undefined,
        "viewer",
      );
    expect(canApply(parent)).toBe(expected);
    expect(canApply({ ...parent, updatedAt: 2_002 })).toBe(false);
  },
);

it.each([
  ["unfiltered", "system:maintenance", {}],
  ["excludeSubagents", "subagent:worker", { excludeSubagents: true }],
  ["excludeCron", "cron:scheduled", { excludeCron: true }],
  ["excludeSystem", "system:maintenance", { excludeSystem: true }],
  ["dock-inclusive", "board-agent", { excludeDock: false }],
] as const)("keeps list and subscription membership scoped for %s", async (name, key, filter) => {
  const ordinary = row("ordinary", { agentId: "main" });
  const dock = name === "dock-inclusive";
  const excluded = row(key, { isDock: dock });
  const primary = name === "unfiltered";
  let primaryRows = dock ? [ordinary] : [ordinary, excluded];
  const expectedRows = primary ? primaryRows : dock ? [ordinary, excluded] : [ordinary];
  let issued = 0;
  const read = (params?: unknown) => {
    const scoped = Object.entries(filter).every(
      ([field, value]) => asOptionalRecord(params)?.[field] === value,
    );
    return sessionsResult(!primary && scoped ? expectedRows : primaryRows, ++issued);
  };
  const query = { agentId: "main", ...filter };
  const { sessions, watch } = rosterReadFixture(read);
  const updates = vi.fn<(snapshot: SessionListSnapshot) => void>();
  watch(sessions.subscribeList(query, updates));
  const refresh = () => sessions.refresh({ agentId: "main", force: true });
  const tracked = dock ? ordinary : excluded;
  const descriptor = sessions.observeRow({ key: tracked.key, agentId: "main" }, () => {});
  onTestFinished(() => descriptor.dispose());
  await refresh();
  const primaryBefore = sessions.state.result;
  const heldDescriptor = descriptor.row;
  expect(heldDescriptor).toMatchObject(tracked);
  expect(primaryBefore?.sessions).toEqual(primaryRows);
  updates.mockClear();

  const result = await sessions.list(query);
  expect(result?.sessions).toEqual(expectedRows);
  expect(sessions.state.result).toBe(primaryBefore);
  expect(updates).not.toHaveBeenCalled();

  await sessions.refreshList({ ...query, force: true });
  expect(updates.mock.calls.at(-1)?.[0].result?.sessions).toEqual(expectedRows);
  const queryWindow = sessions.listSnapshot(query).result;
  expect(queryWindow?.sessions).toEqual(expectedRows);
  expect(descriptor.isCurrent()).toBe(true);
  expect(descriptor.row).toBe(heldDescriptor);
  expect(sessions.state.result).toBe(primary ? queryWindow : primaryBefore);

  updates.mockClear();
  primaryRows = [...primaryRows, row("later", { agentId: "main" })];
  await refresh();
  expect(sessions.state.result?.sessions).toEqual(primaryRows);
  expect(sessions.listSnapshot(query).result).toBe(primary ? sessions.state.result : queryWindow);
  if (primary) {
    expect(updates.mock.calls.at(-1)?.[0].result).toBe(sessions.state.result);
  } else {
    expect(updates).not.toHaveBeenCalled();
    expect(sessions.listSnapshot(query).result?.sessions).toEqual(expectedRows);
  }
});
