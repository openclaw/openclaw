import { expect, test } from "vitest";
import type { SessionsListResult } from "../../api/types.ts";
import { reconcileSessionChanged } from "./reconcile.ts";

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
