import path from "node:path";
import { afterEach, expect, test } from "vitest";
import type { WebSocket } from "ws";
import type { HelloOk } from "../../packages/gateway-protocol/src/schema/frames.js";
import {
  GATEWAY_OWNER_PROFILE_ID,
  type UsersListResult,
  type UsersSelfResult,
} from "../../packages/gateway-protocol/src/schema/users.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { GatewayAuthConfig, GatewayOperatorRolesConfig } from "../config/types.gateway.js";
import type { OperatorScope } from "./operator-scopes.js";
import type { GatewayServer } from "./server-public.js";
import {
  BROWSER_ORIGIN,
  configureBrowserAuth,
  connectReq,
  CONTROL_UI_CLIENT,
  installGatewayTestHooks,
  openTailscaleWs,
  openWs,
  rpcReq,
  testTailscaleWhois,
  waitForWsClose,
  withGatewayServer,
} from "./server.auth.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const READ_WRITE: OperatorScope[] = ["operator.read", "operator.write"];
const AUTH: GatewayAuthConfig = {
  mode: "token",
  token: "secret",
  allowTailscale: true,
  identityScopes: { "ada@example.test": ["operator.admin"] },
};
const CATALOG = {
  admin: { sessions: { others: "write" }, agents: "*", scopes: ["operator.admin"] },
  member: { sessions: { others: "none" }, agents: "*", scopes: ["operator.read"] },
} satisfies GatewayOperatorRolesConfig["definitions"];

function connections(port: number, server: GatewayServer) {
  const identities = tempDirs.make("openclaw-role-staging-");
  const connect = async (socket: Promise<WebSocket>, label: string, options: object) => {
    const ws = await socket;
    const connected = await connectReq(ws, {
      prePairDevice: true,
      client: CONTROL_UI_CLIENT,
      browserOrigin: BROWSER_ORIGIN,
      deviceIdentityPath: path.join(identities, label, "client", "credentials.sqlite"),
      ...options,
    });
    expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
    return { ws, auth: (connected.payload as HelloOk).auth };
  };
  return {
    person: (login: string, scopes: OperatorScope[]) => {
      testTailscaleWhois.value = { login, name: login };
      const endpoint = server.getTailscaleIngressEndpoint();
      if (!endpoint) {
        throw new Error("expected managed Tailscale listener");
      }
      return connect(
        openTailscaleWs(endpoint, { origin: BROWSER_ORIGIN, "tailscale-user-login": login }),
        login,
        { skipDefaultAuth: true, scopes },
      );
    },
    // Shared-secret owner ingress: the break-glass sign-in that roles never limit.
    owner: () =>
      connect(openWs(port, { origin: BROWSER_ORIGIN }), "owner", {
        token: "secret",
        scopes: ["operator.admin"],
      }),
  };
}

async function request<T extends Record<string, unknown>>(
  ws: WebSocket,
  method: string,
  params?: object,
) {
  const response = await rpcReq<T>(ws, method, params);
  expect(response.ok, `${method}: ${JSON.stringify(response.error)}`).toBe(true);
  return response.payload as T;
}

async function profileId(ws: WebSocket) {
  return (await request<UsersSelfResult>(ws, "users.self")).profile.id;
}

async function listedRoles(ws: WebSocket, ids: string[]) {
  const { profiles } = await request<UsersListResult>(ws, "users.list");
  return ids.map((id) => {
    const { role, effectiveRole, roleSource } = profiles.find((profile) => profile.id === id)!;
    return { role, effectiveRole, roleSource };
  });
}

test("stages role assignments before a default enables them, without limiting the owner", async () => {
  await configureBrowserAuth(AUTH, {
    tailscale: { mode: "serve" },
    roles: { definitions: CATALOG },
  });
  const ids = await withGatewayServer(async ({ port, server }) => {
    const { person, owner } = connections(port, server);
    const ada = await person("ada@example.test", ["operator.admin"]);
    const adaId = await profileId(ada.ws);
    const sam = await person("sam@example.test", READ_WRITE);
    const samId = await profileId(sam.ws);
    sam.ws.close();
    const pat = await person("pat@example.test", READ_WRITE);
    const patId = await profileId(pat.ws);
    pat.ws.close();

    const setRole = (target: string, role: string) =>
      rpcReq(ada.ws, "users.setRole", { profileId: target, role });
    expect(await setRole(samId, "member")).toMatchObject({
      ok: true,
      payload: { profile: { id: samId, role: "member" } },
    });
    expect(await setRole(patId, "ghost")).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('unknown operator role "ghost"') },
    });
    expect(await setRole(GATEWAY_OWNER_PROFILE_ID, "admin")).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("not governed by operator roles") },
    });
    // Staging still retires the person's connections, here the enabling admin's own.
    expect(await setRole(adaId, "admin")).toMatchObject({ ok: true });
    expect(await waitForWsClose(ada.ws, 1_000)).toBe(true);

    // Staged roles cap nobody until a default exists.
    const staged = await person("sam@example.test", READ_WRITE);
    expect(staged.auth.scopes).toEqual(READ_WRITE);
    expect(staged.auth.sessionCap).toBeUndefined();
    const root = await owner();
    const { entries } = await request<{ entries: Array<{ summary: string }> }>(
      root.ws,
      "openclaw.changes.list",
      { limit: 10 },
    );
    // Each committed staging is history naming its target, role and acting admin.
    for (const [target, role] of [
      [adaId, "admin"],
      [samId, "member"],
    ]) {
      expect(entries).toContainEqual(
        expect.objectContaining({
          summary: expect.stringMatching(new RegExp(`${target}.*"${role}" by profile ${adaId}$`)),
        }),
      );
    }
    return { adaId, samId, patId };
  });

  // Enable roles with the minimal default; staged assignments now apply.
  await configureBrowserAuth(AUTH, {
    tailscale: { mode: "serve" },
    roles: { default: "member", definitions: CATALOG },
  });
  await withGatewayServer(async ({ port, server }) => {
    const { person, owner } = connections(port, server);
    const ada = await person("ada@example.test", ["operator.admin"]);
    expect(ada.auth).toMatchObject({ scopes: ["operator.admin"], roleAllowsAdmin: true });
    expect(await listedRoles(ada.ws, [ids.adaId, ids.samId, ids.patId])).toEqual([
      { role: "admin", effectiveRole: "admin", roleSource: "assigned" },
      { role: "member", effectiveRole: "member", roleSource: "assigned" },
      { role: undefined, effectiveRole: "member", roleSource: "default" },
    ]);
    for (const login of ["sam@example.test", "pat@example.test"]) {
      const capped = await person(login, READ_WRITE);
      expect(capped.auth).toMatchObject({ scopes: ["operator.read"], sessionCap: "none" });
    }
    const root = await owner();
    expect(root.auth.scopes).toEqual(["operator.admin"]);
    expect(root.auth.sessionCap).toBeUndefined();
    expect(await profileId(root.ws)).toBe(GATEWAY_OWNER_PROFILE_ID);
    await request(root.ws, "users.list");
  });
});
