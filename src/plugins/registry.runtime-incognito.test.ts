import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { acquireSessionActorStorage } from "../config/sessions/session-actor-storage-acquisition.js";
import {
  runWithSessionActorStorage,
  type SelectedSessionActorStorageBinding,
} from "../config/sessions/session-actor-storage-binding.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as gatewayCreation from "../gateway/session-create-service.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import {
  createOwnershipHarness,
  createOwnershipRegistry,
  createOwnershipSubagent,
} from "./registry-ownership.test-support.js";
import { createPluginRuntime } from "./runtime/index.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };
const lockedHarnessEntry = { agentHarnessId: "test-harness", modelSelectionLocked: true as const };
let stateDir: string;
let storePath: string;

async function withMemoryActor<T>(
  sessionKey: string,
  run: (binding: SelectedSessionActorStorageBinding) => T | Promise<T>,
) {
  const binding = await acquireSessionActorStorage(
    { agentId: "main", storePath, sessionKey },
    { authority, lifetime, create: true },
  );
  assert(binding, "Expected memory acquisition");
  try {
    return await run(binding);
  } finally {
    await binding.actor.release();
  }
}

function withMemorySession<T>(sessionKey: string, run: () => T | Promise<T>) {
  return withMemoryActor(sessionKey, (binding) => runWithSessionActorStorage(binding, run));
}

async function createMemoryEntry(sessionId: string, entry: Partial<InternalSessionEntry> = {}) {
  const sessionKey = `agent:main:dashboard:incognito-${sessionId}`;
  await withMemoryActor(sessionKey, (binding) =>
    binding.actor.storage.mutate(
      {
        type: "session.entry.create",
        input: { entry: { sessionId, updatedAt: Date.now(), incognito: true, ...entry } },
      },
      authority,
    ),
  );
  return sessionKey;
}

function observeSql() {
  const sql = observeHostDataSql();
  onTestFinished(() => {
    sql.restore();
    expect(sql.queries).toEqual([]);
  });
}

beforeAll(() => {
  stateDir = path.join(dirs.make("plugin-incognito-"), "state");
  storePath = resolveIncognitoOpenClawAgentSqlitePath({
    agentId: "main",
    env: { OPENCLAW_STATE_DIR: stateDir },
  });
});

beforeEach(() => vi.stubEnv("OPENCLAW_STATE_DIR", stateDir));

afterAll(() => {
  memorySessionActorOwners.closeDatabase({ agentId: "main", path: storePath });
  vi.unstubAllEnvs();
});

afterEach(() => vi.restoreAllMocks());

function registry() {
  const subagent = createOwnershipSubagent("unexpected", "");
  const runtime = createPluginRuntime({ subagent });
  const plugins = createOwnershipRegistry(runtime);
  const { api: owner } = plugins.createApi("owner");
  const { api: caller } = plugins.createApi("caller");
  const delegatedExecutionPluginIds = ["caller"];
  owner.registerAgentHarness(
    createOwnershipHarness("test-harness", { delegatedExecutionPluginIds }),
  );
  return { runtime, owner, caller, subagent, delegatedExecutionPluginIds };
}

it("keeps memory ownership and by-ID checks out of host SQL", async () => {
  const { owner, caller, subagent } = registry();
  const sessionId = "plugin-owned";
  const key = await createMemoryEntry(sessionId, lockedHarnessEntry);
  observeSql();
  await expect(
    caller.runtime.subagent.run({ sessionKey: key, message: "forbidden" }),
  ).rejects.toThrow('owned by plugin "owner"');
  await withMemorySession(key, () =>
    expect(caller.runtime.gateway.request("sessions.abort", { sessionId })).rejects.toThrow(
      'owned by plugin "owner"',
    ),
  );
  const session = owner.runtime.agent.session;
  const target = { sessionKey: key, storePath };
  const displayName = "owned update";
  await expect(
    session.patchSessionEntry({ ...target, update: () => ({ displayName }) }),
  ).resolves.toMatchObject({ displayName });
  await expect(session.getSessionEntryAsync(target)).resolves.toMatchObject({ displayName });
  expect(subagent.run).not.toHaveBeenCalled();
});

it("classifies sandbox authority from its captured actor despite a different configured store", async () => {
  const { owner } = registry();
  const sessionKey = await createMemoryEntry("workspace-policy", {
    updatedAt: 1,
    sandbox: "required",
  });
  const config: OpenClawConfig = {
    session: {
      store: resolveIncognitoOpenClawAgentSqlitePath({
        agentId: "main",
        env: { OPENCLAW_STATE_DIR: dirs.make("plugin-sandbox-other-root-") },
      }),
    },
    agents: {
      defaults: { sandbox: { mode: "off", scope: "session", workspaceAccess: "rw" } },
      entries: { main: {} },
    },
  };
  const params = { config, agentId: "main", sessionKey, storePath };
  observeSql();
  await withMemorySession(sessionKey, async () => {
    const sandbox = owner.runtime.sandbox;
    const expected = {
      sandboxed: true,
      workspaceAccess: "ro",
      confinementError: "target sandbox is not exclusive to this worker session.",
    };
    expect(sandbox.resolveWorkspaceAuthority(params)).toEqual(expected);
    await expect(
      sandbox.prepareWorkspaceAuthority({ ...params, workspaceDir: "/workspace" }),
    ).resolves.toEqual(expected);
  });
});

it("rechecks delegated harness authority after admission waits", async () => {
  setRuntimeConfigSnapshot({});
  onTestFinished(clearRuntimeConfigSnapshot);
  const { runtime, caller, delegatedExecutionPluginIds } = registry();
  const key = await createMemoryEntry("delegated", lockedHarnessEntry);
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const original = runtime.agent.session.runWithWorkAdmission;
  runtime.agent.session.runWithWorkAdmission = async (params, run) => {
    entered.resolve();
    await release.promise;
    return original(params, run);
  };
  const run = vi.fn(async () => "must-not-run");
  observeSql();
  onTestFinished(() => release.resolve());
  const work = withMemorySession(key, () =>
    caller.runtime.agent.session.runWithWorkAdmission({ storePath, sessionKey: key }, run),
  );
  const rejected = expect(work).rejects.toThrow('owned by plugin "owner"');
  await awaitGateBeforeSettlement(entered.promise, work, "delegated admission did not enter");
  delegatedExecutionPluginIds.length = 0;
  release.resolve();
  await rejected;
  expect(run).not.toHaveBeenCalled();
});

it.each(["finalize", "rollback", "changed" as const])(
  "%s retains the exact actor initializer",
  async (outcome) => {
    const { owner } = registry();
    const initialEntry = {
      ...lockedHarnessEntry,
      pluginExtensions: { test: { initializing: true } },
    };
    const key = await createMemoryEntry(`initialize-${outcome}`, {
      ...initialEntry,
      initializationPending: true,
    });
    observeSql();
    await withMemorySession(key, async () => {
      const session = owner.runtime.agent.session;
      const target = { sessionKey: key, storePath };
      const creation = session.createSessionEntry({
        cfg: {},
        key,
        initialEntry,
        recoverMatchingInitialEntry: true,
        afterCreate: async ({ initialization }) => {
          assert(initialization, "session creation did not supply its initializer");
          initialization.assertCurrent();
          if (outcome === "rollback") {
            throw new Error("initializer rejected");
          }
          if (outcome === "changed") {
            await session.patchSessionEntry({
              ...target,
              update: () => ({ displayName: "concurrent owner" }),
            });
            initialization.assertCurrent();
          }
          return { pluginExtensions: { test: { initialized: true } } };
        },
      });
      if (outcome === "finalize") {
        const { entry } = await creation;
        expect(entry).toMatchObject({ pluginExtensions: { test: { initialized: true } } });
        expect(entry.initializationPending).toBeUndefined();
      } else {
        await expect(creation).rejects.toThrow(
          outcome === "rollback" ? "initializer rejected" : "guarded rollback did not complete",
        );
      }
      const stored = await session.getSessionEntryAsync(target);
      if (outcome === "rollback") {
        expect(stored).toBeUndefined();
      } else if (outcome === "changed") {
        expect(stored?.displayName).toBe("concurrent owner");
      }
    });
  },
);

it("hands memory creation to the existing Gateway creator", async () => {
  const { owner } = registry();
  const create = vi
    .spyOn(gatewayCreation, "createGatewaySession")
    .mockRejectedValue(new Error("creator refused"));
  const key = "agent:main:dashboard:incognito-plugin-create";
  observeSql();
  await expect(
    withMemorySession(key, () =>
      owner.runtime.agent.session.createSessionEntry({
        cfg: {},
        key,
        initialEntry: lockedHarnessEntry,
      }),
    ),
  ).rejects.toThrow("creator refused");
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({ key, incognito: true, authorizedAgentHarnessId: "test-harness" }),
  );
});
