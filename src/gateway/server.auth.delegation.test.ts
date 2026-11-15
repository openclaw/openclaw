import { randomBytes } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterEach, expect, test, vi } from "vitest";
import type { WebSocket } from "ws";
import type { HelloOk } from "../../packages/gateway-protocol/src/schema/frames.js";
import type {
  UsersListResult,
  UsersSelfResult,
} from "../../packages/gateway-protocol/src/schema/users.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getPairedDevice, listDevicePairing } from "../infra/device-pairing.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "./control-ui-bootstrap-contract.js";
import { buildControlUiUserAvatarPath } from "./control-ui-user-avatar-route.js";
import { seedApprovedOperatorReadPairing } from "./server.auth.control-ui.fixtures.test-support.js";
import {
  BROWSER_ORIGIN,
  configureBrowserAuth,
  connectReq,
  CONTROL_UI_CLIENT,
  createSignedDevice,
  installGatewayTestHooks,
  openWs,
  onceMessage,
  readConnectChallengeNonce,
  rpcReq,
  TRUSTED_BROWSER_HEADERS,
  waitForWsClose,
  withGatewayServer,
} from "./server.auth.test-helpers.js";
import {
  getTestPluginRegistry,
  resetTestPluginRegistry,
  setTestPluginRegistry,
} from "./test-helpers.plugin-registry.js";

installGatewayTestHooks({ scope: "suite" });
afterEach(resetTestPluginRegistry);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

test("delegated browsers retain profile identity and enforce scopes and current authority", async () => {
  const credentialFile = join(tempDirs.make("gateway-browser-delegation-"), "key");
  const key = randomBytes(32).toString("hex");
  writeFileSync(credentialFile, key, { mode: 0o600 });
  await configureBrowserAuth(
    {
      mode: "trusted-proxy",
      // A conflicting broad static grant must not widen a delegated operator.
      identityScopes: { [`oce:v1:${"a".repeat(64)}`]: ["operator.admin"] },
      trustedProxy: {
        userHeader: "x-occ-identity",
        allowLoopback: true,
        allowUsers: ["external@example.test"],
        deviceAutoApprove: { enabled: true, scopes: ["operator.admin"] },
        delegation: { credentialFile },
      },
    },
    {
      roles: {
        default: "member",
        definitions: {
          member: { scopes: ["operator.admin"], agents: "*", sessions: { others: "view" } },
          reader: { scopes: ["operator.sessions.read"], agents: "*", sessions: { others: "none" } },
        },
      },
    },
  );
  const pluginPath = "/plugins/delegation-proof";
  setTestPluginRegistry({
    ...getTestPluginRegistry(),
    controlUiDescriptors: [
      {
        pluginId: "delegation-proof",
        source: "test",
        descriptor: { surface: "tab", id: "proof", label: "Proof", path: pluginPath },
      },
    ],
    httpRoutes: [
      {
        pluginId: "delegation-proof",
        source: "test",
        path: pluginPath,
        auth: "gateway",
        match: "exact",
        handler: async (_req, res) => {
          res.end("proof");
          return true;
        },
      },
    ],
  });
  await withGatewayServer(
    async ({ port }) => {
      const sockets: WebSocket[] = [];
      const headers = (subject: string, scope: string, credential = key) => ({
        ...TRUSTED_BROWSER_HEADERS,
        "x-occ-identity": `oce:v1:${subject.repeat(64)}`,
        "x-occ-browser-key": credential,
        "x-openclaw-scopes": scope,
      });
      const readHttp = async (path: string, subject: string, scope: string, credential = key) => {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          headers: headers(subject, scope, credential),
        });
        return {
          status: response.status,
          cookies: response.headers.getSetCookie(),
          body: await response.text(),
        };
      };
      const connect = async (
        subject: string,
        scope: string,
        credential = key,
        paired?: { identityPath: string; token: string },
      ) => {
        const ws = await openWs(port, headers(subject, scope, credential));
        sockets.push(ws);
        const { device } = await createSignedDevice({
          token: paired?.token ?? null,
          identityPath: paired?.identityPath,
          role: "operator",
          scopes: ["operator.admin"],
          clientId: CONTROL_UI_CLIENT.id,
          clientMode: CONTROL_UI_CLIENT.mode,
          nonce: await readConnectChallengeNonce(ws),
        });
        const connected = await connectReq(ws, {
          skipDefaultAuth: true,
          role: "operator",
          scopes: ["operator.admin"],
          device,
          deviceToken: paired?.token,
          client: CONTROL_UI_CLIENT,
          browserOrigin: BROWSER_ORIGIN,
        });
        return { ws, connected, auth: (connected.payload as HelloOk | undefined)?.auth };
      };
      try {
        const before = await listDevicePairing();
        const operator = await connect("a", "operator.sessions.write");
        expect(operator.connected.ok, JSON.stringify(operator.connected.error)).toBe(true);
        expect(operator.auth?.scopes).toEqual(["operator.sessions.write"]);
        expect(operator.auth?.deviceToken).toBeUndefined();
        const self = await rpcReq<UsersSelfResult>(operator.ws, "users.self", {});
        expect(self.ok, JSON.stringify(self.error)).toBe(true);
        const profileId = self.payload!.profile.id;
        expect((await rpcReq(operator.ws, "sessions.list", {})).ok).toBe(true);
        const denied = await rpcReq(operator.ws, "exec.approvals.get", {});
        expect(denied.ok).toBe(false);
        expect(denied.error?.message).toContain("missing scope");
        const admin = await connect("b", "operator.admin");
        expect(admin.connected.ok).toBe(true);
        expect(admin.auth?.deviceToken).toBeUndefined();
        const adminSelf = await rpcReq<UsersSelfResult>(admin.ws, "users.self", {});
        expect(adminSelf.ok).toBe(true);
        expect(adminSelf.payload!.profile.id).not.toBe(profileId);
        expect((await rpcReq(admin.ws, "exec.approvals.get", {})).ok).toBe(true);
        expect(await listDevicePairing()).toEqual(before);
        // The first request for this person is HTTP, so profile creation cannot rely on WS connect.
        const png =
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
        expect(
          (
            await rpcReq(admin.ws, "users.setAvatar", {
              profileId,
              mime: "image/png",
              avatarBase64: png,
            })
          ).ok,
        ).toBe(true);
        const avatar = await fetch(
          `http://127.0.0.1:${port}${buildControlUiUserAvatarPath(profileId)}`,
          { headers: headers("c", "operator.sessions.write") },
        );
        expect(avatar.status).toBe(200);
        expect(Buffer.from(await avatar.arrayBuffer())).toEqual(Buffer.from(png, "base64"));
        expect(avatar.headers.getSetCookie()).toEqual([]);
        const roster = await rpcReq<UsersListResult>(admin.ws, "users.list", {});
        const httpProfile = roster.payload?.profiles.find(
          (profile) => profile.displayName === "OCE user cccccccc",
        );
        expect(httpProfile).toBeDefined();
        const httpPerson = await connect("c", "operator.sessions.write");
        expect(
          (await rpcReq<UsersSelfResult>(httpPerson.ws, "users.self", {})).payload?.profile.id,
        ).toBe(httpProfile?.id);
        expect(await readHttp("/v1/models", "c", "operator.sessions.write")).toMatchObject({
          status: 403,
          cookies: [],
          body: expect.stringContaining("missing scope"),
        });
        expect((await readHttp("/v1/models", "c", "operator.admin")).status).toBe(200);
        // The same eligible tab issues a cookie for static proxy admins, never delegated admins.
        const staticBootstrap = await fetch(
          `http://127.0.0.1:${port}${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`,
          {
            headers: {
              ...TRUSTED_BROWSER_HEADERS,
              "x-occ-identity": "external@example.test",
              "x-openclaw-scopes": "operator.admin",
            },
          },
        );
        expect(staticBootstrap.status).toBe(200);
        expect(staticBootstrap.headers.getSetCookie()).toEqual([
          expect.stringContaining(`Path=${pluginPath}`),
        ]);
        expect(await staticBootstrap.json()).toMatchObject({
          pluginFrameGrants: [{ pluginId: "delegation-proof", path: pluginPath, match: "exact" }],
        });
        const delegatedBootstrap = await readHttp(
          CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
          "b",
          "operator.admin",
        );
        expect(delegatedBootstrap).toMatchObject({ status: 200, cookies: [] });
        expect(JSON.parse(delegatedBootstrap.body).pluginFrameGrants).toEqual([]);
        const reconnect = await connect("a", "operator.sessions.write");
        expect(
          (await rpcReq<UsersSelfResult>(reconnect.ws, "users.self", {})).payload?.profile.id,
        ).toBe(profileId);
        // A previously approved admin device must neither widen nor replace delegation.
        const seeded = await seedApprovedOperatorReadPairing({
          identityPrefix: "delegation-admin-device",
          clientId: CONTROL_UI_CLIENT.id,
          clientMode: CONTROL_UI_CLIENT.mode,
          displayName: "Previously approved",
          platform: "web",
          scopes: ["operator.admin"],
        });
        const savedDevice = await getPairedDevice(seeded.identity.deviceId);
        const savedToken = savedDevice?.tokens?.operator?.token;
        expect(savedToken).toBeTruthy();
        const paired = { identityPath: seeded.identityPath, token: savedToken! };
        // A real competing writer makes first-use profile persistence fail. Even a valid
        // admin device must not bypass that failure. Keep the production SQLite timeout.
        const blockingWriter = openNodeSqliteDatabase(resolveOpenClawStateSqlitePath());
        blockingWriter.exec("BEGIN IMMEDIATE");
        try {
          expect(
            (await readHttp(CONTROL_UI_BOOTSTRAP_CONFIG_PATH, "d", "operator.admin")).status,
          ).toBe(401);
          const unavailable = await connect("d", "operator.admin", key, paired);
          expect(unavailable.connected.ok).toBe(false);
          expect(unavailable.connected.error?.code).toBe("UNAVAILABLE");
          expect(unavailable.auth?.deviceToken).toBeUndefined();
        } finally {
          blockingWriter.exec("ROLLBACK");
          blockingWriter.close();
        }
        expect(
          (await readHttp(CONTROL_UI_BOOTSTRAP_CONFIG_PATH, "d", "operator.admin")).status,
        ).toBe(200);
        const recovered = await connect("d", "operator.admin");
        expect(recovered.connected.ok).toBe(true);
        const recoveredSelf = await rpcReq<UsersSelfResult>(recovered.ws, "users.self", {});
        expect(recoveredSelf.ok).toBe(true);
        const recoveredAgain = await connect("d", "operator.admin");
        expect(
          (await rpcReq<UsersSelfResult>(recoveredAgain.ws, "users.self", {})).payload?.profile.id,
        ).toBe(recoveredSelf.payload!.profile.id);
        const bounded = await connect("a", "operator.sessions.write", key, paired);
        expect(bounded.connected.ok).toBe(true);
        expect(bounded.auth?.scopes).toEqual(["operator.sessions.write"]);
        expect(bounded.auth?.deviceToken).toBeUndefined();
        const spoof = await connect("a", "operator.admin", randomBytes(32).toString("hex"), paired);
        expect(spoof.connected.ok).toBe(false);
        // A native administrator can narrow a person's role, which closes existing connections.
        expect((await rpcReq(admin.ws, "users.setRole", { profileId, role: "reader" })).ok).toBe(
          true,
        );
        expect(await waitForWsClose(operator.ws, 3000)).toBe(true);
        const narrowed = await connect("a", "operator.sessions.write");
        expect(narrowed.connected.ok).toBe(true);
        expect(narrowed.auth?.scopes).toEqual(["operator.sessions.read"]);
        expect(
          (await rpcReq<UsersSelfResult>(narrowed.ws, "users.self", {})).payload?.profile.id,
        ).toBe(profileId);
        // Establish a real subscription and positive event before revoking its credential.
        const created = await rpcReq<{ key: string }>(admin.ws, "sessions.create", {
          agentId: "main",
        });
        expect(created.ok, JSON.stringify(created.error)).toBe(true);
        const sessionKey = created.payload!.key;
        expect((await rpcReq(admin.ws, "sessions.subscribe", {})).ok).toBe(true);
        const eventBefore = onceMessage(
          admin.ws,
          (event) => event.event === "sessions.changed" && event.payload?.sessionKey === sessionKey,
        );
        expect(
          (await rpcReq(admin.ws, "sessions.patch", { key: sessionKey, label: "before-rotation" }))
            .ok,
        ).toBe(true);
        await eventBefore;
        const nextKey = randomBytes(32).toString("hex");
        writeFileSync(credentialFile, nextKey);
        // Real watcher publication is the synchronization point, not a fixed delay.
        await vi.waitFor(
          async () =>
            expect((await readHttp("/v1/models", "b", "operator.admin", nextKey)).status).toBe(200),
          { timeout: 3000 },
        );
        const fresh = await connect("b", "operator.admin", nextKey);
        expect(fresh.connected.ok).toBe(true);
        const staleEvents: unknown[] = [];
        admin.ws.on("message", (data) => {
          const frame = JSON.parse(rawDataToString(data));
          if (frame.event === "sessions.changed" && frame.payload?.sessionKey === sessionKey) {
            staleEvents.push(frame);
          }
        });
        expect(
          (await rpcReq(fresh.ws, "sessions.patch", { key: sessionKey, label: "after-rotation" }))
            .ok,
        ).toBe(true);
        expect(await waitForWsClose(admin.ws, 3000)).toBe(true);
        expect(staleEvents).toEqual([]);
        unlinkSync(credentialFile);
        await vi.waitFor(
          async () =>
            expect((await readHttp("/v1/models", "b", "operator.admin", nextKey)).status).toBe(401),
          { timeout: 3000 },
        );
        const staleResponses: unknown[] = [];
        fresh.ws.on("message", (data) => {
          const frame = JSON.parse(rawDataToString(data));
          if (frame.id === "revoked-rpc" && frame.ok) {
            staleResponses.push(frame);
          }
        });
        fresh.ws.send(
          JSON.stringify({ type: "req", id: "revoked-rpc", method: "users.self", params: {} }),
        );
        expect(await waitForWsClose(fresh.ws, 3000)).toBe(true);
        expect(staleResponses).toEqual([]);
      } finally {
        for (const ws of sockets) {
          ws.close();
        }
      }
    },
    { serverOptions: { controlUiEnabled: true, openAiChatCompletionsEnabled: true } },
  );
});
