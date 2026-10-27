import { randomUUID } from "node:crypto";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { expect, test, vi } from "vitest";
import type { WebSocket } from "ws";
import type { GatewayOperatorRolesConfig } from "../config/types.gateway.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { setDisplayName, setUserProfileRole } from "../state/user-profile-writes.worker.js";
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
  rpcReq,
  withGatewayServer,
} from "./server.auth.test-helpers.js";
import { setTestPluginRegistry } from "./test-helpers.plugin-registry.js";

installGatewayTestHooks({ scope: "suite" });

// Runs when the production transcript append starts, after the last pre-append caller check.
const transcriptAppend = vi.hoisted(() => ({ onStart: undefined as (() => void) | undefined }));
vi.mock("./server-methods/chat-transcript-inject.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./server-methods/chat-transcript-inject.js")>();
  return {
    ...actual,
    appendInjectedAssistantMessageToTranscript: (
      ...args: Parameters<typeof actual.appendInjectedAssistantMessageToTranscript>
    ) => {
      transcriptAppend.onStart?.();
      return actual.appendInjectedAssistantMessageToTranscript(...args);
    },
  };
});

// The Team guest shape: a default role bound to visitor-access, viewing others' sessions.
const roles: GatewayOperatorRolesConfig = {
  default: "guest",
  definitions: {
    guest: {
      accessPolicyPlugin: "visitor-access",
      sessions: { others: "view" },
      agents: "*",
      scopes: ["operator.sessions.write"],
      sandbox: "required",
      modelPolicy: {},
    },
    staff: { sessions: { others: "write" }, agents: "*", scopes: ["operator.admin"] },
  },
};

type Welcome = {
  grant: unknown;
  sessionKey?: string;
  messageId?: string;
  session?: unknown;
  error?: string;
};

async function connectAs(
  port: number,
  email: string,
  scopes = ["operator.read", "operator.write"],
): Promise<WebSocket> {
  const ws = await openWs(port, { ...TRUSTED_BROWSER_HEADERS, "x-forwarded-user": email });
  const connected = await connectReq(ws, {
    prePairDevice: true,
    client: CONTROL_UI_CLIENT,
    browserOrigin: BROWSER_ORIGIN,
    skipDefaultAuth: true,
    scopes,
  });
  expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
  return ws;
}

test("a guest's plugin RPC sees its visitor grant, owns the session it creates, and gets an agent message", async () => {
  await configureBrowserAuth(browserProxyAuth(), { roles });
  const staff = ensureProfileForEmail("staff@example.com");
  setUserProfileRole(staff.id, "staff");
  setDisplayName(staff.id, "Staff");
  const guest = ensureProfileForEmail("visitor@example.com");
  let visitorGrant = new AbortController();
  const { config, registry } = createPluginRegistryFixture();
  registerTestPlugin({
    registry,
    config,
    record: createPluginRecord({ id: "visitor-access", origin: "bundled" }),
    register(api) {
      api.registerGatewayAccessPolicy({
        authorize: ({ requiredByRole }) => {
          const current = visitorGrant;
          return requiredByRole
            ? {
                grantId: "grant-1",
                signal: current.signal,
                assertCurrent: () => current.signal.throwIfAborted(),
              }
            : undefined;
        },
      });
      api.registerGatewayMethod(
        "visitor-access.probe",
        async ({ client, params, respond }) => {
          const grant = client?.internal?.operatorAccessAuthority?.gatewayAccessGrant ?? null;
          // Invitation notes are literal: a directive-like token must not change the bytes.
          const text = "Welcome! @Staff invited you. Please test [[audio_as_voice]] replies.";
          const mentions = [{ profileId: staff.id, start: 9, end: 15 }];
          try {
            const sessionKey =
              typeof params.key === "string" ? params.key : `agent:main:dashboard:${randomUUID()}`;
            if (params.describe === true) {
              // Welcome setup checks that a ready session still exists, as the guest.
              const { session } = await api.runtime.gateway.request<{ session: unknown }>(
                "sessions.describe",
                { key: sessionKey, agentId: "main" },
                { scopes: ["operator.sessions.read"] },
              );
              respond(true, { grant, sessionKey, session } satisfies Welcome);
              return;
            }
            if (params.create === true) {
              // A retry after a crash repeats creation against the reserved key.
              await api.runtime.gateway.request("sessions.create", {
                key: sessionKey,
                agentId: "main",
                displayName: "Welcome, Visitor",
              });
            }
            const appended = await api.runtime.gateway.appendAgentMessage({
              sessionKey,
              agentId: "main",
              text,
              mentions,
              idempotencyKey: `welcome:${sessionKey}`,
            });
            respond(true, { grant, sessionKey, messageId: appended.messageId } satisfies Welcome);
          } catch (error) {
            respond(true, { grant, error: String(error) } satisfies Welcome);
          }
        },
        { scope: "operator.sessions.write", profileAccess: "required" },
      );
    },
  });
  setTestPluginRegistry(registry.registry);
  await withGatewayServer(async ({ port }) => {
    const staffWs = await connectAs(port, "staff@example.com");
    const guestWs = await connectAs(port, "visitor@example.com");
    const probe = (params: Record<string, unknown>, ws = guestWs) =>
      rpcReq<Welcome>(ws, "visitor-access.probe", params);
    const history = (sessionKey: string) =>
      rpcReq<{ messages: Array<Record<string, unknown>> }>(staffWs, "chat.history", {
        sessionKey,
        agentId: "main",
      });
    const inbox = () =>
      rpcReq<{ items: Array<Record<string, unknown>> }>(staffWs, "mentions.list", {});
    try {
      // Staff have no visitor grant reference; the guest's handler client carries its grant.
      expect(await probe({ key: "agent:main:main" }, staffWs)).toMatchObject({
        ok: true,
        payload: { grant: null },
      });
      const welcome = await probe({ create: true });
      expect(welcome.payload, JSON.stringify(welcome)).toMatchObject({
        grant: { pluginId: "visitor-access", grantId: "grant-1" },
        sessionKey: expect.any(String),
        messageId: expect.any(String),
      });
      const sessionKey = welcome.payload?.sessionKey ?? "";
      const retried = await probe({ key: sessionKey, create: true });
      expect(retried.payload, JSON.stringify(retried)).toMatchObject({
        sessionKey,
        messageId: welcome.payload?.messageId,
      });

      const listed = await rpcReq<{ sessions: Array<Record<string, unknown>> }>(
        staffWs,
        "sessions.list",
        {},
      );
      expect(listed.payload?.sessions.find((row) => row.key === sessionKey)).toMatchObject({
        createdActor: { type: "human", id: guest.id },
      });
      expect((await history(sessionKey)).payload?.messages).toMatchObject([
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Welcome! @Staff invited you. Please test [[audio_as_voice]] replies.",
            },
          ],
          __openclaw: { humanMentions: [{ profileId: staff.id, start: 9, end: 15 }] },
        },
      ]);
      expect((await inbox()).payload?.items).toMatchObject([
        { senderProfileId: guest.id, sessionKey, messageId: welcome.payload?.messageId },
      ]);

      // A guest's own welcome session is visible to its plugin RPC until an administrator deletes it.
      const described = await probe({ key: sessionKey, describe: true });
      expect(described.payload, JSON.stringify(described)).toMatchObject({
        session: { key: sessionKey },
      });
      const deletedKey = `agent:main:dashboard:${randomUUID()}`;
      const created = await rpcReq(guestWs, "sessions.create", {
        key: deletedKey,
        agentId: "main",
      });
      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      const adminWs = await connectAs(port, "staff@example.com", ["operator.admin"]);
      const deleted = await rpcReq(adminWs, "sessions.delete", {
        key: deletedKey,
        agentId: "main",
      });
      adminWs.close();
      expect(deleted.ok, JSON.stringify(deleted.error)).toBe(true);
      expect(await probe({ key: deletedKey, describe: true })).toMatchObject({
        ok: true,
        payload: { session: null },
      });

      // The seam keeps the caller's own write authority: a guest cannot write staff sessions.
      const staffSession = `agent:main:dashboard:${randomUUID()}`;
      expect(
        (await rpcReq(staffWs, "sessions.create", { key: staffSession, agentId: "main" })).ok,
      ).toBe(true);
      const denied = await probe({ key: staffSession });
      expect(denied.payload?.error).toContain("require your own session");
      expect((await history(staffSession)).payload?.messages).toEqual([]);

      // Revoking the real visitor grant after the transcript append has started stops
      // the durable message and its Inbox entry.
      const revokedKey = `agent:main:dashboard:${randomUUID()}`;
      transcriptAppend.onStart = () => {
        transcriptAppend.onStart = undefined;
        visitorGrant.abort(new Error("Grant revoked"));
      };
      const revoked = await probe({ key: revokedKey, create: true }).catch(() => undefined);
      expect(revoked?.payload?.messageId).toBeUndefined();
      expect(transcriptAppend.onStart).toBeUndefined();
      visitorGrant = new AbortController();
      expect((await history(revokedKey)).payload?.messages ?? []).toEqual([]);
      expect((await inbox()).payload?.items).toHaveLength(1);
    } finally {
      staffWs.close();
      guestWs.close();
    }
  });
});
