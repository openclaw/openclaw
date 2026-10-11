// @vitest-environment node
import { afterEach, assert, expect, it, vi } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createGatewayConnectionLifecycle } from "../gateway-connection-lifecycle.ts";
import type { ObservedSessionList } from "./session-list-query.ts";
import { createSessionRosterObservations } from "./session-roster-observations.ts";
import * as rowProvenance from "./session-row-provenance.ts";

afterEach(() => vi.restoreAllMocks());

function result(sessions: GatewaySessionRow[]): SessionsListResult {
  return {
    ts: 1,
    path: "(synthetic)",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

it.each(["main", "global"])(
  "projects %s receipts from lists and descriptors without indexing unrelated identities",
  (key) => {
    const provenance = rowProvenance.createSessionRowProvenance();
    const identity = vi.spyOn(provenance, "identity");
    vi.spyOn(rowProvenance, "createSessionRowProvenance").mockReturnValue(provenance);
    const connection = createGatewayConnectionLifecycle({
      phase: "connected",
      client: createTestGatewayClient(async () => ({})),
    });
    const lists = new Map<string, ObservedSessionList>();
    let primary: SessionsListResult | null = null;
    const observations = createSessionRosterObservations(
      {
        connection,
        observerError: () => null,
        readState: () => ({ result: primary, agentId: "main" }),
        decorate: (value) => value,
      },
      lists,
    );
    const row: GatewaySessionRow = {
      key,
      sessionId: " selected ",
      kind: "direct",
      label: "Primary",
      snapshotAt: 100,
    };
    const descriptor = {
      ...row,
      key: key === "main" ? "agent:main:main" : key,
      snapshotAt: 150,
      providerReview: undefined,
    };
    provenance.observeReadRow(descriptor, 2, "main");
    observations.registerRow({ key, agentId: "main" }, () => {}, {
      isValid: () => true,
      decorate: (value) => value,
    });
    observations.stageObservedRows([descriptor], connection.capture(), "main", 2)();
    const unrelated = Array.from({ length: 300 }, (_, index) => ({
      ...row,
      key: `agent:main:unrelated-${index}`,
      sessionId: `unrelated-${index}`,
    }));
    const unrelatedRow = unrelated[0];
    assert(unrelatedRow);
    const validUnrelated = vi.fn(() => true);
    provenance.observeReadRow(unrelatedRow, 1, "main");
    observations.registerRow({ key: unrelatedRow.key, agentId: "main" }, () => {}, {
      isValid: validUnrelated,
      decorate: (value) => value,
    });
    observations.stageObservedRows([unrelatedRow], connection.capture(), "main", 1)();
    provenance.observeReadRow(row, 1, "main");
    primary = result([row, ...unrelated]);
    const fresh = {
      ...row,
      key: descriptor.key,
      label: "Newer list",
      snapshotAt: 200,
      providerReview: { id: "pause", runId: "run", canContinue: false },
    };
    provenance.observeReadRow(fresh, 3, "main");
    for (const [name, agentId, rows] of [
      ["fresh", "main", [...unrelated, fresh]],
      [
        "other-owner",
        "other",
        [
          {
            ...fresh,
            key: key === "main" ? "agent:other:main" : key,
            agentId: "other",
            label: "Other owner",
          },
        ],
      ],
      ["other-incarnation", "main", [{ ...fresh, sessionId: "selected", label: "Other ID" }]],
    ] as const) {
      lists.set(name, {
        scope: { agentId },
        connectionEpoch: connection.epoch,
        snapshot: { result: result([...rows]), agentId, loading: false, error: null },
        listeners: new Set(),
      });
    }
    identity.mockClear();
    validUnrelated.mockClear();

    const projected = observations.projectRows([row])[0];
    assert(projected);
    expect(projected).toEqual({ ...fresh, key });
    expect(validUnrelated).toHaveBeenCalled();
    expect(identity.mock.calls.every(([candidate]) => candidate.sessionId === row.sessionId)).toBe(
      true,
    );
    identity.mockClear();
    expect(observations.projectFields(row, "main")).toEqual(projected);
    expect(identity.mock.calls.every(([candidate]) => candidate.sessionId === row.sessionId)).toBe(
      true,
    );
    expect(observations.prepareProjection().projectRows([row])[0]).toEqual(projected);
    expect(observations.projectRows(primary.sessions)[0]).toEqual(projected);
    expect(observations.projectRows([row, { ...row, sessionId: " " }])[1]?.label).toBe("Primary");
    connection.dispose();
  },
);
