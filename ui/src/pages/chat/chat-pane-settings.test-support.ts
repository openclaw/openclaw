import { expect } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";

export function settingsRow(
  name: string,
  fields: Partial<GatewaySessionRow> = {},
): GatewaySessionRow {
  return {
    key: `agent:main:${name}`,
    sessionId: `${name}-session`,
    agentId: "main",
    kind: "direct",
    updatedAt: 1,
    thinkingLevel: "high",
    ...fields,
  };
}

export function settingsAck(row: GatewaySessionRow, entry: Partial<GatewaySessionRow>) {
  return { ok: true, key: row.key, path: "", entry: { sessionId: row.sessionId, ...entry } };
}

export async function mountSettings(
  { sessions, mount }: ReturnType<typeof createMountedPanes>,
  initial: GatewaySessionRow,
  filterToKey = false,
) {
  await sessions.refresh({ agentId: "main", force: true });
  const panes = [mount(initial.key), mount(initial.key)];
  await Promise.all(panes.map(refreshPane));
  const assertRows = (expected: Partial<GatewaySessionRow>) => {
    const rows = sessions.state.result?.sessions;
    expect(filterToKey ? rows?.filter((row) => row.key === initial.key) : rows).toEqual([
      expect.objectContaining(expected),
    ]);
    for (const pane of panes) {
      expect(pane.state.currentSessionId).toBe(expected.sessionId);
      expect(selectedChatSessionRow(pane.state)).toMatchObject(expected);
    }
  };
  return { panes, assertRows };
}
