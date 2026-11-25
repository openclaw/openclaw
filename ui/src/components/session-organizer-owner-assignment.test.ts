/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import type { SidebarSessionMutationScope } from "./app-sidebar-session-types.ts";
import type { SessionActionHost } from "./session-organizer-batch-mutations.ts";
import { assignSessionOwner } from "./session-organizer-operations.runtime.ts";

function createHarness() {
  let current = true;
  let rejectAssignment: ((error: unknown) => void) | undefined;
  const assignOwner = vi.fn(
    () =>
      new Promise<null>((_resolve, reject) => {
        rejectAssignment = reject;
      }),
  );
  const publishSessionMutationError = vi.fn();
  const snapshot = {
    client: {},
    phase: "connected",
    hello: gatewayHelloForMethods(["sessions.assignOwner"], ["operator.write"]),
  } as ApplicationGatewaySnapshot;
  const scope = {
    gateway: { snapshot },
    sessions: {
      assignOwner,
    } as unknown as SessionCapability,
    selectedAgentId: "main",
  } as SidebarSessionMutationScope;
  const host = {
    sessionData: {
      isSessionMutationScopeCurrent: vi.fn(() => current),
      publishSessionMutationError,
    },
  } as unknown as SessionActionHost;
  const session = {
    key: "agent:main:owner-proof",
  };
  return {
    assignOwner,
    host,
    publishSessionMutationError,
    retire: () => {
      current = false;
    },
    scope,
    session,
    reject: (error: unknown) => rejectAssignment?.(error),
  };
}

describe("assignSessionOwner", () => {
  it("publishes a current capability rejection at the action surface", async () => {
    const harness = createHarness();
    const pending = assignSessionOwner(
      harness.host,
      harness.session,
      { type: "human", id: "profile-ada" },
      harness.scope,
    );

    const failure = new Error("Owner assignment rejected.");
    harness.reject(failure);
    await pending;

    expect(harness.publishSessionMutationError).toHaveBeenCalledWith(harness.scope, failure);
  });

  it("keeps a retired assignment rejection silent", async () => {
    const harness = createHarness();
    const pending = assignSessionOwner(
      harness.host,
      harness.session,
      { type: "human", id: "profile-ada" },
      harness.scope,
    );

    harness.retire();
    harness.reject(new Error("Retired assignment rejection."));
    await pending;

    expect(harness.assignOwner).toHaveBeenCalledOnce();
    expect(harness.publishSessionMutationError).not.toHaveBeenCalled();
  });
});
