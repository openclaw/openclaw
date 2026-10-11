import { expect, it } from "vitest";
import { createHarness } from "../model-providers/model-providers-page.test-support.ts";
import { captureModelSetupConnection, reconcileModelSetupConnection } from "./first-run-setup.ts";

function connection() {
  const snapshot = captureModelSetupConnection(createHarness("writer").context, false);
  if (!snapshot.hello?.auth) {
    throw new Error("Expected an authenticated test Gateway");
  }
  return {
    ...snapshot,
    hello: { ...snapshot.hello, auth: { ...snapshot.hello.auth, recoveryScope: "test-owner" } },
    connectionRevision: 1,
    recoveryScope: "test-owner",
    selectionIntentRevision: 1,
  };
}

it("keeps the admitted owner pending and observes same-agent roster recovery", () => {
  const previous = connection();
  const unloaded = {
    ...previous,
    agentId: null,
    selectionPending: true,
    connected: false,
  };
  const pending = reconcileModelSetupConnection(previous, unloaded);
  expect(pending.kind).toBe("pending");
  expect(pending.connection.agentId).toBe("writer");
  expect(reconcileModelSetupConnection(pending.connection, unloaded).kind).toBe("unchanged");
  expect(reconcileModelSetupConnection(pending.connection, previous).kind).toBe("changed");
});

it.each(["intent", "gateway", "removed-agent", "authority"] as const)(
  "does not preserve the old owner after %s changes",
  (change) => {
    const previous = connection();
    const next = { ...previous, agentId: null, selectionPending: true, connected: false };
    if (change === "intent") {
      next.selectionIntentRevision += 1;
    }
    if (change === "gateway") {
      next.connectionRevision += 1;
    }
    if (change === "removed-agent") {
      next.selectionPending = false;
    }
    if (change === "authority") {
      next.connected = true;
      next.hello = {
        ...previous.hello,
        auth: { ...previous.hello.auth, scopes: ["operator.read"] },
      };
    }
    expect(reconcileModelSetupConnection(previous, next)).toEqual({
      kind: "changed",
      connection: next,
    });
  },
);
