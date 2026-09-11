// @vitest-environment node
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../../test-helpers/gateway-client.ts";
import { fetchChildSessionRows } from "./child-session-data.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
} from "./session-capability.test-support.ts";

const parentKey = "agent:main:parent";

function childRow(index: number): GatewaySessionRow {
  return {
    key: `agent:worker:child-${index}`,
    spawnedBy: parentKey,
    kind: "direct",
    updatedAt: index,
  };
}

function listResult(
  sessions: GatewaySessionRow[],
  totalCount: number,
  nextOffset: number | null,
): SessionsListResult {
  return {
    ts: 1,
    path: "",
    count: sessions.length,
    totalCount,
    hasMore: nextOffset !== null,
    nextOffset,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

function capability(request: GatewayRequestHandler) {
  const sessions = createTestSessionCapability(
    createGatewayHarness(createTestGatewayClient(request)).gateway,
  );
  onTestFinished(() => sessions.dispose());
  return sessions;
}

describe("fetchChildSessionRows", () => {
  it("loads a default 50-child Swarm roster in one request", async () => {
    const children = Array.from({ length: 50 }, (_, index) => childRow(index));
    const renamed = {
      ...children[0]!,
      sessionId: "persisted-child-0",
      updatedAt: 20,
      label: "New child name",
    };
    children[0] = renamed;
    const previous = { ...renamed, updatedAt: 10, label: "Old child name" };
    const sessions = capability((method, params) => {
      expect(method).toBe("sessions.list");
      return (params as { spawnedBy?: string }).spawnedBy === parentKey
        ? listResult(children, children.length, null)
        : listResult([previous], 1, null);
    });
    await sessions.refresh({ force: true, agentId: "worker" });
    expect(sessions.state.result?.sessions[0]?.label).toBe(previous.label);
    const list = vi.spyOn(sessions, "list");

    const rows = await fetchChildSessionRows({
      sessions,
      parentKey,
      isCurrent: () => true,
    });

    expect(rows).toHaveLength(50);
    expect(list).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledWith({
      spawnedBy: parentKey,
      limit: 100,
      includeGlobal: false,
      includeUnknown: false,
      configuredAgentsOnly: true,
    });
    const sampled = rows?.find((row) => row.key === renamed.key);
    expect(sampled).toBeDefined();
    expect(sessions.reconcile(sampled)).toBe(true);
    expect(sessions.state.result?.sessions.find((row) => row.key === renamed.key)?.label).toBe(
      renamed.label,
    );
  });

  it("continues paging when a child roster exceeds the default page", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => childRow(index));
    const lastPage = [childRow(100)];
    const request = vi
      .fn()
      .mockResolvedValueOnce(listResult(firstPage, 101, 100))
      .mockResolvedValueOnce(listResult(lastPage, 101, null));
    const sessions = capability(request);
    const list = vi.spyOn(sessions, "list");

    const rows = await fetchChildSessionRows({
      sessions,
      parentKey,
      isCurrent: () => true,
    });

    expect(rows).toHaveLength(101);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[1]?.[0]).toMatchObject({ offset: 100, limit: 100 });
  });
});
