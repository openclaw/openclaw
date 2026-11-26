import { assert, expect, test, vi } from "vitest";
import type { WebSocket } from "ws";
import { closeGatewayTestWebSocket } from "../../test/helpers/gateway-websocket.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { withFreshOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly-open.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import type { OperatorScope } from "./operator-scopes.js";
import {
  configureBrowserAuth,
  connectReq,
  installGatewayTestHooks,
  openWs,
  rpcReq,
  TRUSTED_BROWSER_HEADERS,
  withGatewayServer,
} from "./server.auth.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const key = (name: string) => `agent:main:${name}`;
function row(name: string) {
  const result = withFreshOpenClawAgentDatabaseReadOnly(
    ({ db }) => db.prepare("SELECT * FROM session_nodes WHERE session_key = ?").get(key(name)),
    { agentId: "main" },
  );
  assert(result.found && result.value, `missing persisted session: ${name}`);
  return result.value;
}

function patch(socket: WebSocket, name: string, fields: object) {
  const target = { key: key(name), agentId: "main", expectedSessionId: name };
  return rpcReq<{ archiveUndoToken?: string }>(socket, "sessions.patch", { ...target, ...fields });
}

test("guarded Archive Undo restores only the committed shared pin and refuses superseded receipts", async () => {
  const scopes: OperatorScope[] = ["operator.read", "operator.write"];
  await configureBrowserAuth(undefined, {
    roles: {
      default: "writer",
      definitions: { writer: { scopes, agents: "*", sessions: { others: "view" } } },
    },
  });
  await withGatewayServer(async ({ port }) => {
    const sockets: WebSocket[] = [];
    async function connect(caps: string[]) {
      const ws = await openWs(port, TRUSTED_BROWSER_HEADERS);
      sockets.push(ws);
      const hello = await connectReq(ws, {
        client: { id: "openclaw-macos", mode: "ui", platform: "macOS", version: "1.0.0" },
        skipDefaultAuth: true,
        prePairDevice: true,
        scopes,
        caps,
      });
      const undo = ["session-archive-undo-v1"];
      const capabilities = caps.length
        ? expect.arrayContaining([...caps, ...undo])
        : expect.not.arrayContaining(undo);
      expect(hello.ok, hello.error?.message).toBe(true);
      expect(hello.payload).toMatchObject({
        auth: { method: "trusted-proxy", scopes },
        features: { capabilities },
      });
      return ws;
    }
    try {
      const personal = await connect(["personal-session-pins"]);
      const legacy = await connect([]);
      const creator = ensureProfileForEmail(TRUSTED_BROWSER_HEADERS["x-forwarded-user"]);
      for (const name of ["shared", "personal", "anchor"]) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: key(name) },
          {
            sessionId: name,
            updatedAt: 1,
            visibility: "shared",
            pinnedAt: name === "shared" ? 21 : undefined,
            createdActor: { type: "human", source: "profile", id: creator.id },
          },
        );
      }
      const names = ["personal", "anchor"];
      const entries = { "ui.railShortcuts": names.map((n) => `session:${key(n)}`) };
      expect(await rpcReq(personal, "users.prefs.set", { entries })).toMatchObject({
        ok: true,
        payload: { status: "ok" },
      });
      async function checkOrder(order: string[]) {
        const r = await rpcReq<{ sessions: { key: string }[] }>(personal, "sessions.list", {
          agentId: "main",
          pinned: true,
        });
        expect(r.ok, r.error?.message).toBe(true);
        expect(r.payload?.sessions.map((s) => s.key)).toEqual(order.map(key));
      }
      const archive = async (name: string) => {
        const r = await patch(personal, name, { archived: true, requestArchiveUndo: true });
        expect(r.ok, r.error?.message).toBe(true);
        const token = r.payload?.archiveUndoToken;
        assert(typeof token === "string" && token.length > 0, "missing Archive Undo token");
        expect(row(name)).toMatchObject({
          current_session_id: name,
          archived_at: expect.any(Number),
          pinned_at: null,
        });
        return token;
      };
      const undo = (name: string, token: string) =>
        patch(personal, name, { archived: false, archiveUndoToken: token });
      async function expectStale(token: string) {
        const before = row("shared");
        expect(await undo("shared", token)).toMatchObject({
          ok: false,
          error: { code: "INVALID_REQUEST", message: expect.stringMatching(/no longer current/i) },
        });
        expect(row("shared")).toEqual(before);
      }

      await checkOrder(names);
      expect(row("shared").pinned_at).toBe(21);
      const spent = await archive("shared");
      const start = Date.now();
      expect(await undo("shared", spent)).toMatchObject({ ok: true });
      const restored = row("shared");
      expect(restored.archived_at).toBeNull();
      expect(restored.pinned_at).toBeGreaterThanOrEqual(start);
      expect(restored.pinned_at).toBeLessThanOrEqual(Date.now());

      expect(row("personal").pinned_at).toBeNull();
      const personalOnly = await archive("personal");
      await checkOrder(["anchor"]);
      expect(await undo("personal", personalOnly)).toMatchObject({ ok: true });
      expect(row("personal")).toMatchObject({ archived_at: null, pinned_at: null });
      await checkOrder(names);

      // An unused receipt and a consumed receipt must both leave the replacement redeemable.
      const tick = Date.now();
      using clock = vi.spyOn(Date, "now");
      clock.mockReturnValue(tick);
      const superseded = await archive("shared");
      expect(row("shared").archived_at).toBe(tick);
      expect(await patch(legacy, "shared", { archived: false, pinned: true })).toMatchObject({
        ok: true,
      });
      expect(row("shared")).toMatchObject({ archived_at: null, pinned_at: tick });
      const current = await archive("shared");
      expect(row("shared").archived_at).toBe(tick);
      await expectStale(superseded);
      await expectStale(spent);
      expect(await undo("shared", current)).toMatchObject({ ok: true });
      expect(row("shared")).toMatchObject({ archived_at: null, pinned_at: expect.any(Number) });

      const cleared = await archive("shared");
      expect(await patch(legacy, "shared", { pinned: false })).toMatchObject({ ok: true });
      expect(row("shared")).toMatchObject({ archived_at: tick, pinned_at: null });
      await expectStale(cleared);

      expect(await patch(personal, "shared", { archived: false })).toMatchObject({ ok: true });
      expect(
        await patch(legacy, "shared", { archived: true, requestArchiveUndo: true }),
      ).toMatchObject({
        ok: false,
        error: { code: "FORBIDDEN" },
      });
      expect(row("shared")).toMatchObject({ archived_at: null, pinned_at: null });
      const expired = await archive("shared");
      clock.mockReturnValue(tick + 60 * 60_000);
      await expectStale(expired);
      expect(await patch(personal, "shared", { archived: false })).toMatchObject({ ok: true });
      expect(row("shared")).toMatchObject({ archived_at: null, pinned_at: null });
    } finally {
      await Promise.all(sockets.map(closeGatewayTestWebSocket));
    }
  });
});
