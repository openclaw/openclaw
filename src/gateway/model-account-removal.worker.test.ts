import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { capturePersonalAuthProfileAuthorization } from "../agents/auth-profiles/personal-authorization.js";
import { resolveSessionAuthSelection } from "../agents/auth-profiles/session-override.js";
import { resolveDefaultSessionStorePath } from "../config/sessions/paths.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import * as targets from "../config/sessions/targets-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { connectUserModelAccountAsync } from "../state/user-model-account-operations.js";
import { listUserModelAccounts, readUserModelAuthProfile } from "../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createModelAccountConnectService,
  getModelAccountRemoval,
} from "./model-account-connect.js";

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

/** The destructive entry point stays Gateway-internal: off the service object and its shipped type. */
function removalFor(service: ReturnType<typeof createModelAccountConnectService>) {
  // @ts-expect-error removeAsync must not appear on the SDK-shipped service type.
  void service.removeAsync;
  expect(service).not.toHaveProperty("removeAsync");
  const removal = getModelAccountRemoval(service);
  if (!removal) {
    throw new Error("createModelAccountConnectService did not register its removal operation");
  }
  return removal;
}

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
    const removal = removalFor(service);
    try {
      for (const agent of ["main", "writer"]) {
        await sessionAccessor.replaceSessionEntry(session(agent), {
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
        await sessionAccessor.replaceSessionEntry(session(agent, "kept"), {
          sessionId: `${agent}-kept`,
          updatedAt: 18,
          authProfileOverride: kept,
        });
      }
      const result = await removal.removeAsync(
        { owner, actorProfileId: owner, assertCurrent() {} },
        removed,
      );
      expect(result).toMatchObject({
        removed: true,
        authProfileId: removed,
        sessionCleanup: "complete",
        // Both agents' pinned sessions were cleared once; kept sessions do not count.
        clearedSessions: 2,
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
        const entry = sessionAccessor.loadSessionEntryReadOnly(session(agent));
        expect(entry).toMatchObject({
          updatedAt: 17,
          modelOverride: "example-model",
          providerOverride: "synthetic",
          modelFallback: { prevModel: "old-model" },
        });
        expect(entry?.authProfileOverride).toBeUndefined();
        expect(entry?.modelFallback?.prevAuthProfileOverride).toBeUndefined();
        expect(
          sessionAccessor.loadSessionEntryReadOnly(session(agent, "kept"))?.authProfileOverride,
        ).toBe(kept);
      }
      expect(
        await removal.removeAsync({ owner, actorProfileId: owner, assertCurrent() {} }, removed),
      ).toMatchObject({ removed: false, sessionCleanup: "complete", clearedSessions: 0 });
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
    await sessionAccessor.replaceSessionEntry(scope, {
      sessionId: "partial",
      updatedAt: 1,
      authProfileOverride: removed,
    });
    const service = createModelAccountConnectService({ getConfig: () => cfg });
    const removal = removalFor(service);
    const action = { owner, actorProfileId: owner, assertCurrent() {} };
    try {
      const discovery = vi
        .spyOn(targets, "listKnownSessionStoreAgentIdsAsync")
        .mockRejectedValueOnce(new Error("synthetic unreadable store"));
      expect(await removal.removeAsync(action, removed)).toMatchObject({
        removed: true,
        sessionCleanup: "pending",
        links: [],
      });
      expect(readUserModelAuthProfile(removed)).toBeUndefined();
      expect(sessionAccessor.loadSessionEntryReadOnly(scope)?.authProfileOverride).toBe(removed);
      discovery.mockRestore();
      expect(await removal.removeAsync(action, removed)).toMatchObject({
        removed: false,
        sessionCleanup: "complete",
        clearedSessions: 1,
      });
      expect(sessionAccessor.loadSessionEntryReadOnly(scope)?.authProfileOverride).toBeUndefined();
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
    const removal = removalFor(service);
    try {
      await expect(
        removal.removeAsync({ owner, actorProfileId, assertCurrent() {} }, removed),
      ).rejects.toThrow();
      await expect(
        removal.removeAsync(
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

it("clears removed current and rollback pins from live incognito sessions without durable persistence", async () => {
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
    const owner = ensureProfileForEmail("incognito@example.test").id;
    const removed = (await connect(owner, "incognito-removed")).authProfileId;
    const sentinel = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
    const pinned = {
      agentId: "main",
      sessionKey: "agent:main:dashboard:incognito-removed",
      storePath: sentinel,
    };
    const unrelated = {
      agentId: "main",
      sessionKey: "agent:main:dashboard:incognito-kept",
      storePath: sentinel,
    };
    await sessionAccessor.createSessionEntryWithTranscript(pinned, () => ({
      ok: true,
      entry: {
        sessionId: "incognito-removed-entry",
        updatedAt: 21,
        incognito: true,
        modelOverride: "example-model",
        authProfileOverride: removed,
        authProfileOverrideSource: "user",
        modelFallback: {
          source: "agent-patch",
          ts: 2,
          prevModel: "old-model",
          prevProvider: "synthetic",
          prevAuthProfileOverride: removed,
        },
      },
    }));
    await sessionAccessor.createSessionEntryWithTranscript(unrelated, () => ({
      ok: true,
      entry: {
        sessionId: "incognito-kept-entry",
        updatedAt: 22,
        incognito: true,
        authProfileOverride: "synthetic:gateway",
        authProfileOverrideSource: "user",
      },
    }));
    const service = createModelAccountConnectService({ getConfig: () => cfg });
    const removal = removalFor(service);
    try {
      const result = await removal.removeAsync(
        { owner, actorProfileId: owner, assertCurrent() {} },
        removed,
      );
      expect(result).toMatchObject({ removed: true, sessionCleanup: "complete" });
      const entry = sessionAccessor.loadSessionEntryReadOnly(pinned);
      expect(entry).toMatchObject({
        updatedAt: 21,
        modelOverride: "example-model",
        modelFallback: {
          source: "agent-patch",
          prevModel: "old-model",
          prevProvider: "synthetic",
        },
      });
      expect(entry?.authProfileOverride).toBeUndefined();
      expect(entry?.authProfileOverrideSource).toBeUndefined();
      expect(entry?.modelFallback?.prevAuthProfileOverride).toBeUndefined();
      expect(sessionAccessor.loadSessionEntryReadOnly(unrelated)?.authProfileOverride).toBe(
        "synthetic:gateway",
      );
      // Incognito namespaces stay memory-only: no sentinel or transcript reaches durable storage.
      expect(fs.existsSync(sentinel)).toBe(false);
      const durableFiles: string[] = [];
      const collect = (dir: string) => {
        for (const name of fs.readdirSync(dir)) {
          const full = `${dir}/${name}`;
          if (fs.statSync(full).isDirectory()) {
            collect(full);
          } else {
            durableFiles.push(full);
          }
        }
      };
      collect(state.stateDir);
      expect(durableFiles.filter((file) => file.includes("incognito"))).toEqual([]);
      // Auth selection no longer resolves the removed personal account.
      await expect(
        resolveSessionAuthSelection({
          cfg,
          agentId: "main",
          agentDir: state.agentDir(),
          provider: "synthetic",
          modelId: "example-model",
          sessionEntry: entry!,
          sessionStore: { [pinned.sessionKey]: entry! },
          sessionKey: pinned.sessionKey,
          storePath: sentinel,
          isNewSession: false,
        }),
      ).resolves.toMatchObject({ profileId: "synthetic:gateway" });
    } finally {
      await service.stop();
      memorySessionActorOwners.closeDatabase({ agentId: "main", path: sentinel });
    }
  });
});

it("does not create an incognito memory owner for removal without live incognito sessions", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await state.writeConfig(cfg);
    const owner = ensureProfileForEmail("no-incognito@example.test").id;
    const removed = (await connect(owner, "no-incognito")).authProfileId;
    const sentinel = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
    const service = createModelAccountConnectService({ getConfig: () => cfg });
    const removal = removalFor(service);
    try {
      expect(
        await removal.removeAsync({ owner, actorProfileId: owner, assertCurrent() {} }, removed),
      ).toMatchObject({ removed: true, sessionCleanup: "complete" });
      expect(memorySessionActorOwners.read({ agentId: "main", path: sentinel })).toBeUndefined();
      expect(fs.existsSync(sentinel)).toBe(false);
    } finally {
      await service.stop();
    }
  });
});

it("clears incognito pins for agents that have no durable session store", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await state.writeConfig(cfg);
    const owner = ensureProfileForEmail("incognito-agent@example.test").id;
    const removed = (await connect(owner, "incognito-agent")).authProfileId;
    const sentinel = resolveIncognitoOpenClawAgentSqlitePath({
      agentId: "ephemeral",
      env: state.env,
    });
    const scope = {
      agentId: "ephemeral",
      sessionKey: "agent:ephemeral:dashboard:incognito-agent",
      storePath: sentinel,
    };
    await sessionAccessor.createSessionEntryWithTranscript(scope, () => ({
      ok: true,
      entry: {
        sessionId: "incognito-agent-entry",
        updatedAt: 9,
        incognito: true,
        authProfileOverride: removed,
        authProfileOverrideSource: "user",
      },
    }));
    const service = createModelAccountConnectService({ getConfig: () => cfg });
    const removal = removalFor(service);
    try {
      expect(sessionAccessor.loadSessionEntryReadOnly(scope)?.authProfileOverride).toBe(removed);
      expect(
        await removal.removeAsync({ owner, actorProfileId: owner, assertCurrent() {} }, removed),
      ).toMatchObject({ removed: true, sessionCleanup: "complete" });
      expect(sessionAccessor.loadSessionEntryReadOnly(scope)?.authProfileOverride).toBeUndefined();
      expect(fs.existsSync(sentinel)).toBe(false);
    } finally {
      await service.stop();
      memorySessionActorOwners.closeDatabase({ agentId: "ephemeral", path: sentinel });
    }
  });
});

it("reports incognito cleanup as pending when the memory patch fails and clears it on retry", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await state.writeConfig(cfg);
    const owner = ensureProfileForEmail("incognito-pending@example.test").id;
    const removed = (await connect(owner, "incognito-pending")).authProfileId;
    const sentinel = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:dashboard:incognito-pending",
      storePath: sentinel,
    };
    await sessionAccessor.createSessionEntryWithTranscript(scope, () => ({
      ok: true,
      entry: {
        sessionId: "incognito-pending-entry",
        updatedAt: 5,
        incognito: true,
        authProfileOverride: removed,
      },
    }));
    const service = createModelAccountConnectService({ getConfig: () => cfg });
    const removal = removalFor(service);
    const action = { owner, actorProfileId: owner, assertCurrent() {} };
    const patch = vi
      .spyOn(sessionAccessor, "patchSessionEntryCore")
      .mockRejectedValueOnce(new Error("synthetic incognito cleanup failure"));
    try {
      expect(await removal.removeAsync(action, removed)).toMatchObject({
        removed: true,
        sessionCleanup: "pending",
      });
      expect(sessionAccessor.loadSessionEntryReadOnly(scope)?.authProfileOverride).toBe(removed);
      patch.mockRestore();
      expect(await removal.removeAsync(action, removed)).toMatchObject({
        removed: false,
        sessionCleanup: "complete",
        clearedSessions: 1,
      });
      expect(sessionAccessor.loadSessionEntryReadOnly(scope)?.authProfileOverride).toBeUndefined();
    } finally {
      patch.mockRestore();
      await service.stop();
      memorySessionActorOwners.closeDatabase({ agentId: "main", path: sentinel });
    }
  });
});
