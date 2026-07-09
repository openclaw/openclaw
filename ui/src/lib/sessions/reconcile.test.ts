import { describe, expect, it, test } from "vitest";
import type { SessionsListResult } from "../../api/types.ts";
import { reconcileSessionChanged } from "./reconcile.ts";

function buildResult(sessions: SessionsListResult["sessions"]): SessionsListResult {
  return {
    ts: 1,
    path: "store",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

test("sessions.changed removes a label when the event carries null", () => {
  const result: SessionsListResult = {
    ts: 1,
    path: "",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [
      {
        key: "agent:main:main",
        kind: "global",
        updatedAt: 1,
        label: "Named session",
        displayName: "Named session",
      },
    ],
  };

  const reconciled = reconcileSessionChanged(result, {
    sessionKey: "agent:main:main",
    reason: "patch",
    updatedAt: 2,
    label: null,
    displayName: null,
  });

  expect(reconciled.applied).toBe(true);
  expect(reconciled.result?.sessions[0]?.label).toBeUndefined();
  expect(reconciled.result?.sessions[0]?.displayName).toBeUndefined();
});

describe("reconcileSessionChanged", () => {
  it("drops a cleared category from the merged row", () => {
    const key = "agent:main:discord:channel:1";
    const result = buildResult([
      { key, kind: "group", updatedAt: 1, sessionId: "s1", category: "Research" },
    ]);
    const next = reconcileSessionChanged(result, {
      sessionKey: key,
      key,
      kind: "group",
      updatedAt: 2,
      sessionId: "s1",
      category: null,
    });
    expect(next.applied).toBe(true);
    expect(next.row?.category).toBeUndefined();
  });

  it("applies an updated category to the merged row", () => {
    const key = "agent:main:discord:channel:1";
    const result = buildResult([{ key, kind: "group", updatedAt: 1, sessionId: "s1" }]);
    const next = reconcileSessionChanged(result, {
      sessionKey: key,
      key,
      kind: "group",
      updatedAt: 2,
      sessionId: "s1",
      category: "Research",
    });
    expect(next.applied).toBe(true);
    expect(next.row?.category).toBe("Research");
  });
});
