// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createSessionCapability } from "./index.ts";
import { createGatewayHarness, sessionsResult } from "./session-capability.test-support.ts";

const KEY = "agent:main:alpha";

function changedError(successorSessionId?: string): Error {
  const error = new Error(`Session ${KEY} changed before deletion. Retry.`);
  Object.assign(error, {
    name: "GatewayRequestError",
    gatewayCode: "INVALID_REQUEST",
    details: {
      code: "SESSION_CHANGED",
      ...(successorSessionId ? { successorSessionId } : {}),
    },
  });
  return error;
}

function changedHarness(mutation: "sessions.patch" | "sessions.delete", error: Error) {
  let listCalls = 0;
  const request = vi.fn(async (method: string) => {
    if (method === mutation) {
      throw error;
    }
    if (method === "sessions.list") {
      listCalls += 1;
      return sessionsResult([{ key: KEY, kind: "direct", updatedAt: 1 }], listCalls);
    }
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const { gateway } = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
  return { gateway, listCalls: () => listCalls };
}

describe("session-changed mutation rejections", () => {
  it.each([
    {
      name: "names a continuation when the Gateway proved lineage",
      successorSessionId: "sess-successor",
      copy: "continued as a new session",
    },
    {
      name: "reports a replacement when it did not",
      successorSessionId: undefined,
      copy: "was replaced",
    },
  ])("$name", async ({ successorSessionId, copy }) => {
    const { gateway, listCalls } = changedHarness(
      "sessions.patch",
      changedError(successorSessionId),
    );
    const sessions = createSessionCapability(gateway);

    await sessions.refresh({ force: true });
    const before = listCalls();

    await expect(sessions.patch(KEY, { pinned: true })).rejects.toThrow("changed before deletion");

    // The published row is provably stale, so the owner refreshes it rather than
    // leaving every caller to notice.
    expect(listCalls()).toBeGreaterThan(before);
    expect(sessions.state.error).toContain(copy);
    expect(sessions.state.error).toContain(KEY);
    sessions.dispose();
  });

  it("refreshes the stale row when a delete is rejected", async () => {
    const { gateway, listCalls } = changedHarness("sessions.delete", changedError());
    const sessions = createSessionCapability(gateway);

    await sessions.refresh({ force: true });
    const before = listCalls();

    await expect(sessions.delete(KEY)).rejects.toThrow("changed before deletion");

    expect(listCalls()).toBeGreaterThan(before);
    expect(sessions.state.error).toContain("was replaced");
    sessions.dispose();
  });
});
