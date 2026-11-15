import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  entries: [] as Array<
    [
      string,
      { adapter: { requester?: { connectionId?: string } }; active: boolean; sessionKey: string },
    ]
  >,
}));

// mock-isolation: fixed run and connection fixtures stand in for process-global Gateway state.
vi.mock("../../sessions/session-controller.rpc-sources.js", () => ({
  listRpcSourceEntries: () => mocks.entries,
  isRpcSourceActive: (ref: { active: boolean }) => ref.active,
  getRpcSourceIdentity: (ref: { sessionKey: string }) => ({ sessionKey: ref.sessionKey }),
}));

const { createOpenClawIdMemberActivity } = await import("./member-activity.js");

const { recordOpenClawIdTunnelConnection, resetOpenClawIdTunnelConnectionsForTest } =
  await import("./tunnel-connections.js");
afterEach(resetOpenClawIdTunnelConnectionsForTest);

const BOB = `iroh:${"bb".repeat(32)}`;
const CAROL = `iroh:${"cc".repeat(32)}`;
const client = (connId: string, peerKey: string | undefined, lastActivityAt?: number) =>
  ({
    connId,
    connectionLastActivityAt: lastActivityAt,
    internal: peerKey ? { openclawIdPeerKey: peerKey } : {},
  }) as never;

describe("member activity", () => {
  it("counts a member's connections and attributes only its active runs", () => {
    mocks.entries = [
      [
        "run-bob",
        { adapter: { requester: { connectionId: "c-bob" } }, active: true, sessionKey: "s-bob" },
      ],
      [
        "run-old",
        { adapter: { requester: { connectionId: "c-bob" } }, active: false, sessionKey: "s-bob" },
      ],
      [
        "run-local",
        {
          adapter: { requester: { connectionId: "c-local" } },
          active: true,
          sessionKey: "s-local",
        },
      ],
    ];
    const reader = createOpenClawIdMemberActivity({
      clients: () => [
        client("c-bob", BOB, 1_000),
        client("c-bob-2", BOB, 2_000),
        client("c-local", undefined),
      ],
      now: () => 9_000,
    });
    expect(reader.describe([BOB, CAROL])).toEqual({
      [BOB]: {
        connections: 2,
        lastSeenAt: 2_000,
        runs: [{ runId: "run-bob", sessionKey: "s-bob" }],
      },
      [CAROL]: { connections: 0, lastSeenAt: null, runs: [] },
    });
  });

  it("keeps active runs visible after their initiating tunnel connection closes", () => {
    const closed = new AbortController();
    recordOpenClawIdTunnelConnection("c-bob", BOB, closed.signal);
    closed.abort();
    mocks.entries = [
      [
        "run-bob",
        { adapter: { requester: { connectionId: "c-bob" } }, active: true, sessionKey: "s-bob" },
      ],
    ];
    const reader = createOpenClawIdMemberActivity({ clients: () => [] });
    expect(reader.describe([BOB])[BOB]).toEqual({
      connections: 0,
      lastSeenAt: null,
      runs: [{ runId: "run-bob", sessionKey: "s-bob" }],
    });
  });

  it("keeps the last time it saw a member after they disconnect", () => {
    mocks.entries = [];
    let connected = true;
    const reader = createOpenClawIdMemberActivity({
      clients: () => (connected ? [client("c-bob", BOB, 5_000)] : []),
      now: () => 9_000,
    });
    expect(reader.describe([BOB])[BOB]).toMatchObject({ connections: 1, lastSeenAt: 5_000 });
    connected = false;
    expect(reader.describe([BOB])[BOB]).toEqual({ connections: 0, lastSeenAt: 5_000, runs: [] });
  });
});
