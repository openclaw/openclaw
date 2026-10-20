// @vitest-environment node
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

const key = "agent:main:unread-contract";
const sessionId = `${key}:session`;
const receipt = (entry: Partial<GatewaySessionRow> = { updatedAt: 3, lastReadAt: 3 }) => ({
  ok: true,
  key,
  path: "",
  entry: { sessionId, ...entry },
});
function ownSessions(gateway: Parameters<typeof createTestSessionCapability>[0]) {
  const sessions = createTestSessionCapability(gateway);
  onTestFinished(() => sessions.dispose());
  return sessions;
}

function rowUnread(result: SessionsListResult | null): boolean {
  return result?.sessions.find((row) => row.key === key)?.unread === true;
}

function unreadHarness(patchResponse: Promise<unknown>, serverUnread = () => true) {
  let listTs = 0;
  const request = vi.fn(async (method: string) => {
    if (method === "sessions.patch") {
      return await patchResponse;
    }
    if (method === "sessions.list") {
      listTs += 1;
      return sessionsResult(
        [
          {
            key,
            sessionId,
            kind: "direct",
            updatedAt: 1,
            unread: serverUnread(),
            agentStatus: serverUnread()
              ? { note: "Synthetic attention", expiresAt: Number.MAX_SAFE_INTEGER }
              : undefined,
          },
        ],
        listTs,
      );
    }
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const harness = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
  return { ...harness, sessions: ownSessions(harness.gateway), request };
}

describe("session unread mutation capability", () => {
  it.each([
    ["automatic acknowledgement", { expectedMarkedUnreadAt: 42 }],
    ["explicit read", {}],
  ] as const)("sends the current payload for %s", async (_name, expected) => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.patch") {
        return receipt();
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client, ["sessions.patch"]);
    const sessions = ownSessions(gateway);

    await sessions.patch(key, { unread: false }, { ...expected, deferListRefresh: true });

    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key,
      unread: false,
      ...expected,
    });
  });

  it("clears unread before the request settles and rolls a rejection back", async () => {
    const rejected = createDeferred<unknown>();
    const { sessions } = unreadHarness(rejected.promise);

    await sessions.refresh({ force: true });
    const operation = sessions.patch(key, { unread: false }, { deferListRefresh: true });
    const unreadWhilePending = rowUnread(sessions.state.result);

    rejected.reject(new Error("read rejected"));
    await expect(operation).rejects.toThrow("read rejected");
    expect(unreadWhilePending).toBe(false);
    expect(rowUnread(sessions.state.result)).toBe(true);
  });

  it("settles a read receipt without reloading and retains it through stale events and reads", async () => {
    const committed = createDeferred<unknown>();
    let serverUnread = true;
    const { sessions, emitEvent, request } = unreadHarness(committed.promise, () => serverUnread);

    await sessions.refresh({ force: true });
    const operation = sessions.patch(key, { unread: false });
    expect(rowUnread(sessions.state.result)).toBe(false);

    emitEvent({
      type: "event",
      event: "sessions.changed",
      payload: {
        key,
        sessionId,
        kind: "direct",
        reason: "send",
        sessionKey: key,
        unread: true,
        updatedAt: 2,
      },
    });
    expect(rowUnread(sessions.state.result)).toBe(false);

    await sessions.refresh({ force: true });
    expect(rowUnread(sessions.state.result)).toBe(false);

    serverUnread = false;
    committed.resolve(receipt());
    await expect(operation).resolves.toBeTruthy();
    expect(rowUnread(sessions.state.result)).toBe(false);
    expect(sessions.state.result?.sessions[0]?.agentStatus).toBeUndefined();
    expect(request.mock.calls.filter(([method]) => method === "sessions.list")).toHaveLength(2);
  });

  it.each([
    {
      name: "newer manual marker",
      entry: {
        markedUnreadAt: 99,
        updatedAt: 99,
        agentStatus: { note: "New attention", expiresAt: Number.MAX_SAFE_INTEGER },
      },
    },
    {
      name: "activity after another reader cleared the marker",
      entry: { createdAt: 1, lastReadAt: 50, lastActivityAt: 100, updatedAt: 100 },
    },
  ])("restores unread after a stale acknowledgement: $name", async ({ entry }) => {
    const committed = createDeferred<unknown>();
    const { sessions } = unreadHarness(committed.promise);

    await sessions.refresh({ force: true });
    const operation = sessions.patch(
      key,
      { unread: false },
      { expectedMarkedUnreadAt: 41, deferListRefresh: true },
    );
    expect(rowUnread(sessions.state.result)).toBe(false);

    // A mismatched marker returns the current entry without applying or broadcasting.
    committed.resolve(receipt(entry));
    await expect(operation).resolves.toBeTruthy();
    expect(rowUnread(sessions.state.result)).toBe(true);
    expect(sessions.state.result?.sessions[0]?.agentStatus).toEqual(entry.agentStatus);
  });
});
