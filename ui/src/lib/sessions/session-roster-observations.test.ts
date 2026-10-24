// @vitest-environment node
import { afterEach, assert, expect, it, onTestFinished, vi } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createGatewayConnectionLifecycle } from "../gateway-connection-lifecycle.ts";
import { sessionsResult as result } from "./session-capability.test-support.ts";
import type { ObservedSessionList } from "./session-list-query.ts";
import { createSessionRosterObservations } from "./session-roster-observations.ts";
import * as rowProvenance from "./session-row-provenance.ts";

afterEach(() => vi.restoreAllMocks());

function fixture(readResult: () => SessionsListResult | null = () => null) {
  const connection = createGatewayConnectionLifecycle({
    phase: "connected",
    client: createTestGatewayClient(async () => ({})),
  });
  onTestFinished(() => connection.dispose());
  const lists = new Map<string, ObservedSessionList>();
  const observations = createSessionRosterObservations(
    {
      connection,
      observerError: () => null,
      readState: () => ({ result: readResult(), agentId: "main" }),
      decorate: (value) => value,
    },
    lists,
  );
  return {
    observations,
    list: (name: string, rows: GatewaySessionRow[], agentId = "main") =>
      lists.set(name, {
        scope: { agentId },
        connectionEpoch: connection.epoch,
        snapshot: { result: result(rows), agentId, loading: false, error: null },
        listeners: new Set(),
      }),
    stage: (row: GatewaySessionRow, revision: number) =>
      observations.stageObservedRows([row], connection.capture(), "main", revision)(),
    register: (key: string, isValid: (sessionId: string) => boolean = () => true) =>
      observations.registerRow({ key, agentId: "main" }, () => {}, {
        isValid,
        decorate: (value) => value,
      }),
  };
}

it("keeps a valid descriptor when an invalid replacement is observed", () => {
  const { stage, register } = fixture();
  const row: GatewaySessionRow = {
    key: "agent:main:valid",
    kind: "direct",
    sessionId: "current",
    updatedAt: 1,
  };
  const registered = register(row.key, (sessionId) => sessionId === "current");
  stage(row, 1);
  stage({ ...row, sessionId: "rejected", updatedAt: 2 }, 2);
  expect(registered.isCurrent()).toBe(true);
  expect(registered.current()).toEqual(row);
});

it.each(["main", "global"])(
  "projects %s receipts from lists and descriptors without indexing unrelated identities",
  (key) => {
    const provenance = rowProvenance.createSessionRowProvenance();
    const identity = vi.spyOn(provenance, "identity");
    const expectSelectedIdentity = () => {
      expect(identity.mock.calls.every(([candidate]) => candidate.sessionId === " selected ")).toBe(
        true,
      );
      identity.mockClear();
    };
    vi.spyOn(rowProvenance, "createSessionRowProvenance").mockReturnValue(provenance);
    let primary: SessionsListResult | null = null;
    const { list, observations, stage, register } = fixture(() => primary);
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
    register(key);
    stage(descriptor, 2);
    const unrelated = Array.from({ length: 300 }, (_, index) => ({
      ...row,
      key: `agent:main:unrelated-${index}`,
      sessionId: `unrelated-${index}`,
    }));
    const unrelatedRow = unrelated[0];
    assert(unrelatedRow);
    const validUnrelated = vi.fn(() => true);
    register(unrelatedRow.key, validUnrelated);
    stage(unrelatedRow, 1);
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
    list("fresh", [...unrelated, fresh]);
    const otherOwner = {
      ...fresh,
      key: key === "main" ? "agent:other:main" : key,
      agentId: "other",
      label: "Other owner",
    };
    list("other-owner", [otherOwner], "other");
    list("other-incarnation", [{ ...fresh, sessionId: "selected", label: "Other ID" }]);
    identity.mockClear();
    validUnrelated.mockClear();

    const projected = observations.projectRows([row])[0];
    assert(projected);
    expect(projected).toEqual({ ...fresh, key });
    expect(validUnrelated).toHaveBeenCalled();
    expectSelectedIdentity();
    expect(observations.projectFields(row, "main")).toEqual(projected);
    expectSelectedIdentity();
    expect(observations.currentRow(row, "main")).toEqual({ ...fresh, key });
    expectSelectedIdentity();
    expect(observations.currentRow({ ...row, sessionId: "missing" }, "main")).toBeUndefined();
    expect(observations.prepareProjection().projectRows([row])[0]).toEqual(projected);
    expect(observations.projectRows(primary.sessions)[0]).toEqual(projected);
    expect(observations.projectRows([row, { ...row, sessionId: " " }])[1]?.label).toBe("Primary");
    primary = null;
    expect(observations.currentRow(row, "main")).toEqual(fresh);
  },
);
