import { afterEach, expect, it, vi } from "vitest";
import { capturePersonalAuthProfileAuthorization } from "../agents/auth-profiles/personal-authorization.js";
import { resolveSessionAuthSelection } from "../agents/auth-profiles/session-override.js";
import { resolveDefaultSessionStorePath } from "../config/sessions/paths.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import * as targets from "../config/sessions/targets-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { connectUserModelAccountAsync } from "../state/user-model-account-operations.js";
import { listUserModelAccounts, readUserModelAuthProfile } from "../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createModelAccountConnectService } from "./model-account-connect.js";
import type { RespondFn } from "./server-methods/types.js";
import { usersAuthConnectHandlers } from "./server-methods/users-auth-connect.js";
import {
  createContext,
  createOperatorClient,
} from "./server-plugin-in-process-dispatch.test-support.js";

afterEach(() => vi.restoreAllMocks());

const cfg: OpenClawConfig = {
  plugins: { allow: [] },
  agents: { entries: { main: {}, writer: {} } },
};
const session = (agentId: string, suffix = "chat") => ({
  agentId,
  storePath: resolveDefaultSessionStorePath(agentId),
  sessionKey: `agent:${agentId}:${suffix}`,
});
const connect = (ownerProfileId: string, label: string) =>
  connectUserModelAccountAsync({
    ownerProfileId,
    credential: {
      type: "token",
      provider: "synthetic",
      token: `synthetic-${label}`,
      displayName: label,
    },
    assertCurrent() {},
  });

it("removes an owned credential through the worker, retires retained grants and clears current/rollback pins across agents", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await state.writeConfig(cfg);
    const owner = ensureProfileForEmail("remove@example.test").id;
    const other = ensureProfileForEmail("other@example.test").id;
    const removed = (await connect(owner, "removed")).authProfileId;
    const kept = (await connect(owner, "kept-default")).authProfileId;
    const foreign = (await connect(other, "foreign")).authProfileId;
    const grant = await capturePersonalAuthProfileAuthorization({
      profileId: removed,
      assertCurrent() {},
    });
    const service = createModelAccountConnectService({ getConfig: () => cfg });
    try {
      for (const agent of ["main", "writer"]) {
        await replaceSessionEntry(session(agent), {
          sessionId: `${agent}-synthetic`,
          updatedAt: 17,
          providerOverride: "synthetic",
          modelOverride: "example-model",
          authProfileOverride: removed,
          authProfileOverrideSource: "user",
          modelFallback: {
            source: "agent-patch",
            ts: 1,
            prevModel: "old-model",
            prevProvider: "synthetic",
            prevAuthProfileOverride: removed,
          },
        });
        await replaceSessionEntry(session(agent, "kept"), {
          sessionId: `${agent}-kept`,
          updatedAt: 18,
          authProfileOverride: kept,
        });
      }
      const result = await service.removeAsync(
        { owner, actorProfileId: owner, assertCurrent() {} },
        removed,
      );
      expect(result).toMatchObject({
        removed: true,
        authProfileId: removed,
        sessionCleanup: "complete",
        links: [{ authProfileId: kept }],
      });
      expect(readUserModelAuthProfile(removed)).toBeUndefined();
      expect(readUserModelAuthProfile(foreign)).toBeDefined();
      expect(
        listUserModelAccounts({ profileId: owner }).accounts.map(
          (account) => account.authProfileId,
        ),
      ).toEqual([kept]);
      expect(grant.assertCurrent).toThrow();
      for (const agent of ["main", "writer"]) {
        const entry = loadSessionEntryReadOnly(session(agent));
        expect(entry).toMatchObject({
          updatedAt: 17,
          modelOverride: "example-model",
          providerOverride: "synthetic",
          modelFallback: { prevModel: "old-model" },
        });
        expect(entry?.authProfileOverride).toBeUndefined();
        expect(entry?.modelFallback?.prevAuthProfileOverride).toBeUndefined();
        expect(loadSessionEntryReadOnly(session(agent, "kept"))?.authProfileOverride).toBe(kept);
      }
      expect(
        await service.removeAsync({ owner, actorProfileId: owner, assertCurrent() {} }, removed),
      ).toMatchObject({ removed: false, sessionCleanup: "complete" });
    } finally {
      grant.dispose();
      await service.stop();
    }
  });
});

it("reports confirmed deletion separately from failed session cleanup and supports the same-ID retry", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await state.writeConfig(cfg);
    const owner = ensureProfileForEmail("partial@example.test").id;
    const removed = (await connect(owner, "partial")).authProfileId;
    const scope = session("writer");
    await replaceSessionEntry(scope, {
      sessionId: "partial",
      updatedAt: 1,
      authProfileOverride: removed,
    });
    const service = createModelAccountConnectService({ getConfig: () => cfg });
    const action = { owner, actorProfileId: owner, assertCurrent() {} };
    try {
      const discovery = vi
        .spyOn(targets, "listKnownSessionStoreAgentIdsAsync")
        .mockRejectedValueOnce(new Error("synthetic unreadable store"));
      expect(await service.removeAsync(action, removed)).toMatchObject({
        removed: true,
        sessionCleanup: "pending",
        links: [],
      });
      expect(readUserModelAuthProfile(removed)).toBeUndefined();
      expect(loadSessionEntryReadOnly(scope)?.authProfileOverride).toBe(removed);
      discovery.mockRestore();
      expect(await service.removeAsync(action, removed)).toMatchObject({
        removed: false,
        sessionCleanup: "complete",
      });
      expect(loadSessionEntryReadOnly(scope)?.authProfileOverride).toBeUndefined();
      expect(listUserModelAccounts({ profileId: owner }).accounts).toEqual([]);
    } finally {
      await service.stop();
    }
  });
});

it("rejects an admin-shaped actor targeting another owner and rejects shared IDs before mutation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const owner = ensureProfileForEmail("owner@example.test").id;
    const actorProfileId = ensureProfileForEmail("admin@example.test").id;
    const removed = (await connect(owner, "private")).authProfileId;
    const service = createModelAccountConnectService({ getConfig: () => cfg });
    try {
      await expect(
        service.removeAsync({ owner, actorProfileId, assertCurrent() {} }, removed),
      ).rejects.toThrow();
      await expect(
        service.removeAsync(
          { owner, actorProfileId: owner, assertCurrent() {} },
          "synthetic:shared",
        ),
      ).rejects.toThrow();
      expect(readUserModelAuthProfile(removed)).toBeDefined();
    } finally {
      await service.stop();
    }
  });
});

it("serves self-owned removal through the RPC handler and lets the existing chat resolve Gateway auth", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await state.writeConfig(cfg);
    await state.writeAuthProfiles({
      version: 1,
      profiles: {
        "synthetic:gateway": {
          type: "api_key",
          provider: "synthetic",
          key: "synthetic-gateway-key",
        },
      },
    });
    const owner = ensureProfileForEmail("rpc@example.test").id;
    const removed = (await connect(owner, "rpc")).authProfileId;
    const scope = session("main");
    await replaceSessionEntry(scope, {
      sessionId: "rpc-chat",
      updatedAt: 1,
      authProfileOverride: removed,
      authProfileOverrideSource: "user",
    });
    const service = createModelAccountConnectService({ getConfig: () => cfg });
    const client = createOperatorClient({
      profileId: owner,
      scopes: ["operator.read", "operator.write"],
    });
    const context = createContext();
    context.getRuntimeConfig = () => cfg;
    context.getClientConnIds = (filter) =>
      new Set(client.connId && (!filter || filter(client)) ? [client.connId] : []);
    context.modelAccountConnectService = service;
    const respond = vi.fn<RespondFn>();
    const params = { authProfileId: removed };
    try {
      await usersAuthConnectHandlers["users.removeModelAccount"]!({
        req: { type: "req", id: "remove-account", method: "users.removeModelAccount", params },
        params,
        client,
        context,
        respond,
        isWebchatConnect: () => false,
      });
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ removed: true, sessionCleanup: "complete" }),
      );
      const entry = loadSessionEntryReadOnly(scope)!;
      expect(entry.authProfileOverride).toBeUndefined();
      await expect(
        resolveSessionAuthSelection({
          cfg,
          agentId: "main",
          agentDir: state.agentDir(),
          provider: "synthetic",
          modelId: "example-model",
          sessionEntry: entry,
          sessionStore: { [scope.sessionKey]: entry },
          sessionKey: scope.sessionKey,
          storePath: scope.storePath,
          isNewSession: false,
        }),
      ).resolves.toMatchObject({ profileId: "synthetic:gateway" });
      expect(readUserModelAuthProfile(removed)).toBeUndefined();
    } finally {
      await service.stop();
    }
  });
});
