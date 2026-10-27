import { Check } from "typebox/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PresenceQueryResultSchema,
  type PresenceQueryParams,
  type PresenceQueryResult,
} from "../../../packages/gateway-protocol/src/schema/presence.js";
import type { PresenceEntry } from "../../../packages/gateway-protocol/src/schema/snapshot.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { NodeRegistry } from "../node-registry.js";
import { makeClient } from "../node-registry.test-helpers.js";
import type { NodeSession } from "../node-session.types.js";
import type { GatewayMethodDispatchResponse } from "../server-in-process-dispatch.types.js";
import { createGatewayRequestContext } from "../server-request-context.js";
import { makeContextParams } from "../server-request-context.test-support.js";
import { presenceHandlers } from "./presence.js";
import type { GatewayClient } from "./types.js";

const mocks = vi.hoisted(() => ({
  presence: vi.fn<() => PresenceEntry[]>(() => []),
  lookup: vi.fn<() => Promise<GatewayMethodDispatchResponse>>(),
}));
vi.mock("../server-plugin-in-process-dispatch.js", () => ({
  dispatchGatewayMethodInProcessRaw: mocks.lookup,
}));

const now = 10_000;
const profile = (profileId: string, displayName: string) => ({
  profileId,
  displayName,
  avatarRevision: "1",
  hasAvatar: false,
  updatedAt: 1,
});

function row(conn: string, overrides: Partial<PresenceEntry> = {}): PresenceEntry {
  return {
    connectionId: conn,
    deviceId: conn,
    ts: now,
    user: { id: "alex", identity: { type: "profile", id: "alex" }, name: "Alex" },
    ...overrides,
  };
}

function node(id: string, overrides: Partial<NodeSession> = {}): NodeSession {
  return {
    nodeId: id,
    connId: `conn-${id}`,
    client: makeClient(`conn-${id}`, id),
    declaredCaps: [],
    caps: [],
    declaredCommands: [],
    commands: [],
    declaredNodePluginTools: [],
    nodePluginTools: [],
    nodeSkills: [],
    connectedAtMs: 2_000,
    ...overrides,
  };
}

function caller(profileId = "alex"): GatewayClient {
  return {
    ...makeClient("reader", "reader-device"),
    internal: { operatorRoleActor: { kind: "operator", profileId } },
  };
}

function request(
  params: PresenceQueryParams = {},
  options: { nodes?: NodeSession[]; client?: GatewayClient | null; current?: () => boolean } = {},
) {
  const respond = vi.fn();
  const nodeRegistry = new NodeRegistry();
  vi.spyOn(nodeRegistry, "listCurrentConnectedSync").mockImplementation(() => options.nodes ?? []);
  const context = createGatewayRequestContext(makeContextParams({ nodeRegistry }));
  context.getPresenceSnapshot = mocks.presence;
  const run = presenceHandlers["presence.query"]!({
    req: { type: "req", id: "presence-query", method: "presence.query", params },
    params,
    client: options.client === undefined ? caller() : options.client,
    respond,
    isWebchatConnect: () => false,
    hasCurrentClientAuthority: options.current,
    context,
  });
  return { respond, run };
}

async function query(
  params: PresenceQueryParams = {},
  options?: Parameters<typeof request>[1],
): Promise<PresenceQueryResult> {
  const result = request(params, options);
  await result.run;
  const [ok, payload, error] = result.respond.mock.calls[0] ?? [];
  expect([ok, error]).toEqual([true, undefined]);
  if (!Check(PresenceQueryResultSchema, payload)) {
    throw new Error("Invalid presence result");
  }
  return payload;
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  mocks.presence.mockReset().mockReturnValue([]);
  mocks.lookup.mockReset().mockResolvedValue({ ok: false });
});
afterEach(() => vi.restoreAllMocks());

describe("presence.query", () => {
  it("lists one person per qualified identity, without stale rows or private connection details", async () => {
    mocks.presence.mockReturnValue([
      row("tab-a", {
        deviceId: undefined,
        instanceId: "collision",
        watchedSessions: ["private-session"],
        ip: "203.0.113.2",
      }),
      row("tab-b"),
      row("raw", {
        deviceId: undefined,
        instanceId: "collision",
        user: { id: "alex", name: "Other Alex" },
      }),
      row("disconnected", { user: { id: "offline", name: "Offline" }, reason: "disconnect" }),
      { ts: now, reason: "self", host: "Gateway" },
    ]);
    const result = await query();
    expect(result).toMatchObject({
      observedAt: now,
      status: "ok",
      totalPeople: 2,
      truncated: false,
      people: [
        { id: "profile:alex", name: "Alex", deviceCount: 2, activity: null },
        { id: "raw:alex", name: "Other Alex", deviceCount: 1, activity: null },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/private-session|203\.0\.113\.2|watchedSessions/);
    expect(result.people.every((person) => person.devices === undefined)).toBe(true);
    const detailed = await query({ include: ["devices"] });
    expect(
      detailed.people.flatMap((person) => person.devices?.map((device) => device.id) ?? []),
    ).toEqual(["device:tab-b", "instance:profile:alex:collision", "instance:raw:alex:collision"]);
    expect(await query({ limit: 1 })).toMatchObject({
      totalPeople: 2,
      truncated: true,
      people: [{ name: "Alex" }],
    });
  });

  it("binds me to the admitted operator and retains activity on its originating device", async () => {
    const native = node("laptop", { lastActiveAtMs: 8_000, presenceActivitySource: "app" });
    native.client.authenticatedUserProfile = profile("alex", "Alex");
    mocks.presence.mockReturnValue([
      row("tab-a", { deviceId: "desktop", connectionLastActivityAt: 6_000, lastActivityAt: 9_000 }),
      row("tab-b", { deviceId: "desktop", lastActivityAt: 9_000 }),
      row("other-machine", {
        deviceId: undefined,
        instanceId: "other",
        connectionLastActivityAt: 5_000,
        lastActivityAt: 9_000,
      }),
      row("no-device", { deviceId: undefined }),
    ]);
    const result = await query(
      { action: "person", person: "me", include: ["devices"] },
      {
        nodes: [
          native,
          node("shared", { lastActiveAtMs: 9_500, presenceActivitySource: "system" }),
        ],
      },
    );
    expect(result.people).toMatchObject([
      {
        id: "profile:alex",
        deviceCount: 4,
        activity: { at: 8_000, source: "app-input", deviceId: "device:laptop" },
      },
    ]);
    const devices = result.people[0]?.devices;
    expect(devices?.find((device) => device.id === "device:desktop")).toMatchObject({
      activity: { at: 6_000, source: "openclaw-interaction" },
      connections: [{ id: "tab-a" }, { id: "tab-b" }],
    });
    expect(devices?.some((device) => device.id === "connection:no-device")).toBe(true);
    expect(devices?.some((device) => device.id === "device:shared")).toBe(false);
  });

  it("keeps shared nodes inspectable without assigning them to the only online person", async () => {
    mocks.presence.mockReturnValue([row("one")]);
    const shared = node("shared", {
      lastActiveAtMs: 9_000,
      presenceActivitySource: "system",
      remoteIp: "192.0.2.3",
    });
    shared.client.authenticatedUserProfile = profile(GATEWAY_OWNER_PROFILE_ID, "Owner");
    const inspect = async (params: PresenceQueryParams, expected: object, client = caller()) =>
      expect(await query(params, { nodes: [shared], client })).toMatchObject(expected);
    await inspect(
      { include: ["devices"] },
      {
        devices: [{ id: "device:shared", personIds: [], activity: { source: "system-input" } }],
      },
    );
    await inspect(
      { action: "device", deviceId: "device:shared", include: ["network"] },
      {
        devices: [{ nodeId: "shared", connections: [{ network: { ip: "192.0.2.3" } }] }],
        people: [],
      },
    );
    await inspect(
      { action: "person", person: "me", include: ["devices"] },
      {
        status: "not-found",
        people: [],
        devices: [{ id: "device:shared", personIds: [] }],
      },
      caller(GATEWAY_OWNER_PROFILE_ID),
    );
  });

  it("reports ambiguity and unavailable requester identity instead of guessing", async () => {
    mocks.presence.mockReturnValue([
      row("first"),
      row("second", {
        user: { id: "another", identity: { type: "profile", id: "another" }, name: "Alex" },
      }),
    ]);
    const person = async (
      name: string,
      expected: object,
      client: GatewayClient | null = caller(),
    ) =>
      expect(await query({ action: "person", person: name }, { client })).toMatchObject(expected);
    await person("alex", { status: "ok", people: [{ id: "profile:alex" }] });
    await person("ALEX", { status: "ambiguous", totalPeople: 2 });
    await person("nobody", { status: "not-found", people: [] });
    await person("me", { status: "identity-unavailable" }, null);
    await person(
      "me",
      { status: "identity-unavailable" },
      {
        ...caller(),
        internal: { operatorRoleActor: { kind: "system" } },
      },
    );
  });

  it.each([
    { action: "person" },
    { action: "device" },
    { person: "Alex" },
    { limit: 101 },
  ] as PresenceQueryParams[])("rejects incomplete or out-of-range queries %j", async (params) => {
    const result = request(params);
    await result.run;
    expect(result.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("enriches selected connections on demand and never includes IP unless requested", async () => {
    mocks.presence.mockReturnValue([row("tab", { ip: "203.0.113.2", timeZone: "Europe/Vienna" })]);
    mocks.lookup.mockResolvedValue({
      ok: true,
      payload: {
        results: [{ ip: "203.0.113.2", status: "found", city: "Vienna" }],
      },
    });
    const result = await query({ include: ["location"] });
    expect(result.people[0]?.devices?.[0]?.connections).toMatchObject([
      {
        timeZone: "Europe/Vienna",
        location: { source: "ip", status: "found", city: "Vienna" },
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("203.0.113.2");
    expect(mocks.lookup).toHaveBeenCalledWith(
      "geolocation.lookup",
      { ips: ["203.0.113.2"] },
      expect.any(Object),
    );
  });

  it("re-reads connections and checks caller authority after awaited location lookup", async () => {
    mocks.presence.mockReturnValue([row("tab", { ip: "203.0.113.2" })]);
    const lookup = createDeferred<GatewayMethodDispatchResponse>();
    mocks.lookup.mockReturnValue(lookup.promise);
    const result = request({ include: ["location"] });
    mocks.presence.mockReturnValue([]);
    lookup.resolve({ ok: false });
    await result.run;
    expect(result.respond.mock.calls[0]?.[1]).toMatchObject({ people: [], totalPeople: 0 });

    mocks.presence.mockReturnValue([row("tab", { ip: "203.0.113.2" })]);
    let current = true;
    const revoked = request({ include: ["location"] }, { current: () => current });
    current = false;
    await expect(revoked.run).rejects.toThrow("authority changed");
    expect(revoked.respond).not.toHaveBeenCalled();
  });
});
