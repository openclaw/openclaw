import { expect, test } from "vitest";
import type { HelloOk } from "../../packages/gateway-protocol/src/schema/frames.js";
import type { ToolsEffectiveResult } from "../../packages/gateway-protocol/src/schema/tools-catalog.js";
import type { UsersSelfResult } from "../../packages/gateway-protocol/src/schema/users.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { registerAgentHarness } from "../agents/harness/registry.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  BROWSER_ORIGIN,
  CONTROL_UI_CLIENT,
  TRUSTED_BROWSER_HEADERS,
  browserProxyAuth,
  configureBrowserAuth,
  connectReq,
  installGatewayTestHooks,
  openWs,
  onceMessage,
  rpcReq,
  withGatewayServer,
} from "./server.auth.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

test("authenticated session readers can preview only accessible sessions and lose access before egress", async ({
  signal,
}) => {
  const entered = createDeferred();
  const resume = createDeferred();
  let holdPreview = false;
  const harnessId = "tool-preview-gate";
  const sharedKey = "agent:main:shared-tool-preview";
  registerAgentHarness({
    id: harnessId,
    label: "Tool preview fixture",
    supports: () => ({ supported: false }),
    runAttempt: async () => {
      throw new Error("Preview must not run an agent");
    },
    loadMcpToolCatalog: async ({ sessionKey }) => {
      if (holdPreview && sessionKey === sharedKey) {
        entered.resolve();
        await resume.promise;
      }
      return undefined;
    },
  });
  await configureBrowserAuth(browserProxyAuth(), {
    roles: {
      default: "guest",
      definitions: {
        guest: { agents: "*", sessions: { others: "none" }, scopes: ["operator.sessions.read"] },
        viewer: { agents: "*", sessions: { others: "view" }, scopes: ["operator.sessions.read"] },
        admin: { agents: "*", sessions: { others: "write" }, scopes: ["operator.admin"] },
      },
    },
  });
  const { getRuntimeConfig, writeConfigFile } = await import("../config/config.js");
  await writeConfigFile({
    ...getRuntimeConfig(),
    mcp: { servers: { previewFixture: { command: "not-executed" } } },
  });
  const viewer = ensureProfileForEmail("tool-preview-viewer@example.test");
  const admin = ensureProfileForEmail("tool-preview-admin@example.test");
  setUserProfileRole(viewer.id, "viewer");
  setUserProfileRole(admin.id, "admin");
  await withGatewayServer(async ({ port }) => {
    const connect = async (email: string, scopes: string[]) => {
      const ws = await openWs(port, { ...TRUSTED_BROWSER_HEADERS, "x-forwarded-user": email });
      const connected = await connectReq(ws, {
        prePairDevice: true,
        client: CONTROL_UI_CLIENT,
        browserOrigin: BROWSER_ORIGIN,
        skipDefaultAuth: true,
        scopes,
      });
      expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
      expect((connected.payload as HelloOk).auth?.scopes).toEqual(scopes);
      const self = await rpcReq<UsersSelfResult>(ws, "users.self");
      expect(self.ok, JSON.stringify(self.error)).toBe(true);
      return { ws, id: self.payload!.profile.id };
    };
    const guest = await connect("tool-preview-guest@example.test", ["operator.sessions.read"]);
    const reader = await connect("tool-preview-viewer@example.test", ["operator.sessions.read"]);
    const administrator = await connect("tool-preview-admin@example.test", ["operator.admin"]);
    const ownKey = "agent:main:guest-tool-preview";
    const seed = (sessionKey: string, owner: string, visibility: "shared" | "draft") =>
      upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: sessionKey,
          agentHarnessId: harnessId,
          updatedAt: 1,
          visibility,
          createdActor: { type: "human", source: "profile", id: owner },
        },
      );
    await seed(ownKey, guest.id, "draft");
    await seed(sharedKey, administrator.id, "shared");
    const expectPreview = async (ws: typeof guest.ws, sessionKey: string) => {
      const result = await rpcReq<ToolsEffectiveResult>(ws, "tools.effective", { sessionKey });
      expect(result.ok, JSON.stringify(result.error)).toBe(true);
      expect(result.payload?.agentId).toBe("main");
      const names = result.payload?.groups.flatMap((group) => group.tools.map((tool) => tool.id));
      expect(names).toContain("exec");
      expect(result.payload).not.toHaveProperty("toolAccess");
      expect(result.payload).not.toHaveProperty("notices");
    };
    await expectPreview(guest.ws, ownKey);
    await expectPreview(reader.ws, sharedKey);
    const broad = await rpcReq(administrator.ws, "tools.effective", { sessionKey: ownKey });
    expect(broad.ok, JSON.stringify(broad.error)).toBe(true);
    expect(broad.payload).toHaveProperty("toolAccess");
    for (const [ws, sessionKey] of [
      [guest.ws, sharedKey],
      [reader.ws, ownKey],
      [guest.ws, "agent:main:missing-preview"],
    ] as const) {
      expect(await rpcReq(ws, "tools.effective", { sessionKey })).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST", message: expect.stringContaining("not found") },
      });
    }
    expect(await rpcReq(guest.ws, "tools.effective", {})).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    expect(await rpcReq(guest.ws, "config.get", {})).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    // Pause the real inventory owner's awaited harness hook, across the bundled-server boundary.
    holdPreview = true;
    const pending = rpcReq(reader.ws, "tools.effective", { sessionKey: sharedKey });
    const settled = Promise.allSettled([pending]);
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          entered.promise,
          pending,
          "preview did not enter the catalog hook",
        ),
        signal,
      );
      const id = "revoke-preview";
      // rpcReq republishes config; raw transport keeps visibility as the sole invalidation.
      const revoked = onceMessage<Awaited<ReturnType<typeof rpcReq>>>(
        administrator.ws,
        (frame) => frame.type === "res" && frame.id === id,
      );
      administrator.ws.send(
        JSON.stringify({
          type: "req",
          id,
          method: "session.visibility.set",
          params: { sessionKey: sharedKey, visibility: "draft" },
        }),
      );
      const response = await revoked;
      expect(response.ok, JSON.stringify(response.error)).toBe(true);
    } finally {
      resume.resolve();
      await settled;
    }
    const revokedPreview = await pending;
    expect(revokedPreview).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("not found") },
    });
    expect(revokedPreview.payload).toBeUndefined();
  });
});
