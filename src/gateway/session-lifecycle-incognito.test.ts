import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { getSessionActorStorageBinding } from "../config/sessions/session-actor-storage-binding.js";
import { prepareSessionSourceAuthority } from "../config/sessions/session-source-authority.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { sessionCreateHandlers } from "./server-methods/sessions-create.js";
import { deleteGatewaySession } from "./server-methods/sessions-delete.js";
import { messageCutContext } from "./server-methods/sessions-rewind.storage.test-support.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { createGatewaySession } from "./session-create-service.js";
import { performGatewaySessionReset } from "./session-reset-service.js";
import { resolveSessionMutationAuthorization } from "./session-sharing.js";
import { sharingPolicyClient } from "./session-sharing.test-utils.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils-store.js";

const cfg = { agents: { entries: { main: {} } } };

beforeEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));
afterEach(() => {
  resetPluginRuntimeStateForTest();
  memorySessionActorOwners.reset();
});

it.each(["reset", "delete"] as const)(
  "creates, reads, and %ss an incognito session without an ambient actor",
  async (operation) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await state.writeConfig(cfg);
      const sql = observeHostDataSql();
      try {
        expect(getSessionActorStorageBinding({})).toBeUndefined();
        const created = await createGatewaySession({
          cfg,
          incognito: true,
          displayName: "Private conversation",
          commandSource: "test",
          operatorRoleActor: { kind: "system" },
        });
        if (!created.ok) {
          throw new Error(created.error.message);
        }
        expect(getSessionActorStorageBinding({})).toBeUndefined();
        expect(
          loadGatewaySessionEntryReadOnly(created.key, { agentId: "main" }, cfg).entry,
        ).toMatchObject({
          incognito: true,
          sessionId: created.entry.sessionId,
          displayName: "Private conversation",
        });
        if (operation === "reset") {
          expect(
            await performGatewaySessionReset({
              key: created.key,
              agentId: "main",
              reason: "reset",
              commandSource: "test",
              operatorRoleActor: { kind: "system" },
            }),
          ).toMatchObject({ ok: true, incognitoDeleted: true });
        } else {
          expect(
            await deleteGatewaySession({
              params: { key: created.key, agentId: "main" },
              client: null,
              context: messageCutContext(),
            }),
          ).toMatchObject({ ok: true, result: { deleted: true } });
        }
        expect(getSessionActorStorageBinding({})).toBeUndefined();
        expect(
          loadGatewaySessionEntryReadOnly(created.key, { agentId: "main" }, cfg).entry,
        ).toBeUndefined();
        expect(sql.queries.filter(isSessionEntryDataSql)).toEqual([]);
      } finally {
        sql.restore();
      }
    });
  },
);

it("creates a fresh explicit incognito key under authorization captured before its memory owner exists", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await state.writeConfig(cfg);
    const key = "agent:main:dashboard:incognito-explicit-create";
    const location = {
      agentId: "main",
      path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
    };
    const client = sharingPolicyClient({});
    const context = createDirectChatContext({
      getRuntimeConfig: () => cfg,
      getCommittedRuntimeConfig: () => cfg,
    });
    const params = {
      key,
      agentId: "main",
      incognito: true,
      displayName: "Explicit private conversation",
    };
    expect(memorySessionActorOwners.read(location)).toBeUndefined();
    expect(getSessionActorStorageBinding({})).toBeUndefined();
    const resolved = resolveSessionMutationAuthorization({
      client,
      context,
      method: "sessions.create",
      requestParams: params,
    });
    expect(resolved.error).toBeNull();
    const authorization = resolved.authorization;
    if (!authorization) {
      throw new Error("Expected retained session creation authorization");
    }
    const retained = await prepareSessionSourceAuthority(authorization.assertCurrent);
    const respond = vi.fn<GatewayRequestHandlerOptions["respond"]>();
    try {
      expect(memorySessionActorOwners.read(location)).toBeUndefined();
      await sessionCreateHandlers["sessions.create"]!({
        req: { type: "req", id: "explicit-create", method: "sessions.create" },
        params,
        client,
        context,
        respond,
        isWebchatConnect: () => true,
        sessionMutationAuthorization: authorization,
      });
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          ok: true,
          key,
          entry: expect.objectContaining({ incognito: true }),
        }),
      );
      retained.assertCurrent();
      const created = loadGatewaySessionEntryReadOnly(key, { agentId: "main" }, cfg).entry;
      expect(created).toMatchObject({ incognito: true, displayName: params.displayName });
      expect(respond.mock.calls[0]?.[1]).toMatchObject({ sessionId: created?.sessionId });
      expect(getSessionActorStorageBinding({})).toBeUndefined();
    } finally {
      await retained.release?.();
    }
  });
});
