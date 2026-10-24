// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";
import { sessionRpc, sessionRpcHarness, patchReceipt } from "./session-rpc.test-support.ts";

const key = "agent:main:unread-contract";
const sessionId = `${key}:session`;
const receipt = (entry: Partial<GatewaySessionRow> = { updatedAt: 3, lastReadAt: 3 }) =>
  patchReceipt(key, { sessionId, ...entry }, "");
function rowUnread(result: SessionsListResult | null): boolean {
  return result?.sessions.find((row) => row.key === key)?.unread === true;
}

async function unreadHarness() {
  let listTs = 0;
  const response = createDeferred<unknown>();
  const server = { unread: true };
  const harness = sessionRpcHarness({
    "sessions.patch": () => response.promise,
    "sessions.list": () =>
      sessionsResult(
        [
          {
            key,
            sessionId,
            kind: "direct",
            updatedAt: 1,
            unread: server.unread,
            agentStatus: server.unread
              ? { note: "Synthetic attention", expiresAt: Number.MAX_SAFE_INTEGER }
              : undefined,
          },
        ],
        ++listTs,
      ),
    "sessions.subscribe": () => ({ subscribed: true }),
  });
  await harness.sessions.refresh({ force: true });
  return { ...harness, response, server };
}

describe("session unread mutation capability", () => {
  it.each([
    ["automatic acknowledgement", { expectedMarkedUnreadAt: 42 }],
    ["explicit read", {}],
  ] as const)("sends the current payload for %s", async (_name, expected) => {
    const request = sessionRpc({ "sessions.patch": () => receipt() });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client, ["sessions.patch"]);
    const sessions = createTestSessionCapability(gateway);

    await sessions.patch(key, { unread: false }, { ...expected, deferListRefresh: true });

    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key,
      unread: false,
      ...expected,
    });
  });

  it("clears unread before the request settles and rolls a rejection back", async () => {
    const { sessions, response } = await unreadHarness();
    const operation = sessions.patch(key, { unread: false }, { deferListRefresh: true });
    const unreadWhilePending = rowUnread(sessions.state.result);

    response.reject(new Error("read rejected"));
    await expect(operation).rejects.toThrow("read rejected");
    expect(unreadWhilePending).toBe(false);
    expect(rowUnread(sessions.state.result)).toBe(true);
  });

  it("settles a read receipt without reloading and retains it through stale events and reads", async () => {
    const { sessions, changed, request, response, server } = await unreadHarness();
    const operation = sessions.patch(key, { unread: false });
    expect(rowUnread(sessions.state.result)).toBe(false);

    changed({
      key,
      sessionId,
      kind: "direct",
      reason: "send",
      sessionKey: key,
      unread: true,
      updatedAt: 2,
    });
    expect(rowUnread(sessions.state.result)).toBe(false);

    await sessions.refresh({ force: true });
    expect(rowUnread(sessions.state.result)).toBe(false);

    server.unread = false;
    response.resolve(receipt());
    await expect(operation).resolves.toBeTruthy();
    expect(rowUnread(sessions.state.result)).toBe(false);
    expect(sessions.state.result?.sessions[0]?.agentStatus).toBeUndefined();
    expect(request.mock.calls.filter(([method]) => method === "sessions.list")).toHaveLength(2);
  });

  it.each([
    [
      "newer manual marker",
      {
        markedUnreadAt: 99,
        updatedAt: 99,
        agentStatus: { note: "New attention", expiresAt: Number.MAX_SAFE_INTEGER },
      },
    ],
    [
      "activity after another reader cleared the marker",
      { createdAt: 1, lastReadAt: 50, lastActivityAt: 100, updatedAt: 100 },
    ],
  ] as const)(
    "restores unread after a stale acknowledgement: %s",
    async (_name, entry: Partial<GatewaySessionRow>) => {
      const { sessions, response } = await unreadHarness();
      const operation = sessions.patch(
        key,
        { unread: false },
        { expectedMarkedUnreadAt: 41, deferListRefresh: true },
      );
      expect(rowUnread(sessions.state.result)).toBe(false);

      // A mismatched marker returns the current entry without applying or broadcasting.
      response.resolve(receipt(entry));
      await expect(operation).resolves.toBeTruthy();
      expect(rowUnread(sessions.state.result)).toBe(true);
      expect(sessions.state.result?.sessions[0]?.agentStatus).toEqual(entry.agentStatus);
    },
  );
});
