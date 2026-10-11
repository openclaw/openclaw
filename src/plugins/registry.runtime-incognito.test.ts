import "../test-utils/prepare-compiled-subprocesses.js";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withIncognitoSessionActor } from "../config/sessions/session-incognito-binding.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as gatewayCreation from "../gateway/session-create-service.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { openIncognitoTestActor } from "../state/openclaw-agent-execution-incognito.test-support.js";
import { createPluginRecord } from "./loader-records.js";
import { createRuntimeTestRegistry } from "./registry-runtime.test-helpers.js";
import { createPluginRuntime } from "./runtime/index.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {} };
let actor: Awaited<ReturnType<typeof openIncognitoTestActor>>;

beforeAll(async () => {
  const stateDir = path.join(dirs.make("plugin-incognito-"), "state");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  actor = await openIncognitoTestActor({ OPENCLAW_STATE_DIR: stateDir }, authority);
});

afterAll(async () => {
  await actor.close();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function registry() {
  const subagentRun = vi.fn(async () => ({ runId: "unexpected" }));
  const runtime = createPluginRuntime({
    subagent: {
      complete: async () => ({ text: "" }),
      run: subagentRun,
      waitForRun: async () => ({ status: "ok" }),
      getSessionMessages: async () => ({ messages: [] }),
      deleteSession: async () => {},
    },
  });
  const plugins = createRuntimeTestRegistry(runtime);
  const api = (id: string) =>
    plugins.createApi(
      createPluginRecord({
        id,
        source: `/plugins/${id}/index.js`,
        origin: "bundled",
        enabled: true,
        configSchema: false,
      }),
      { config: {} },
    );
  const owner = api("owner");
  const caller = api("caller");
  const harness = {
    id: "test-harness",
    label: "Test harness",
    delegatedExecutionPluginIds: ["caller"],
    supports: () => ({ supported: true as const }),
    runAttempt: async () => {
      throw new Error("unused");
    },
  };
  owner.registerAgentHarness(harness);
  return { runtime, owner, caller, harness, subagentRun };
}

it("keeps explicit actor ownership and by-ID checks out of host SQL", async () => {
  const { owner, caller, subagentRun } = registry();
  const key = "agent:main:dashboard:incognito-plugin-owned";
  const sessionId = "plugin-owned";
  await actor.sessions.create(authority, {
    sessionKey: key,
    entry: {
      sessionId,
      updatedAt: Date.now(),
      incognito: true,
      agentHarnessId: "test-harness",
      modelSelectionLocked: true,
    },
  });
  const sql = observeHostDataSql();
  try {
    await withIncognitoSessionActor(actor, async () => {
      await expect(
        caller.runtime.subagent.run({ sessionKey: key, message: "forbidden" }),
      ).rejects.toThrow('owned by plugin "owner"');
      await expect(caller.runtime.gateway.request("sessions.abort", { sessionId })).rejects.toThrow(
        'owned by plugin "owner"',
      );
      await expect(
        owner.runtime.agent.session.patchSessionEntry({
          sessionKey: key,
          storePath: actor.path,
          update: () => ({ displayName: "owned update" }),
        }),
      ).resolves.toMatchObject({ displayName: "owned update" });
    });
    expect(subagentRun).not.toHaveBeenCalled();
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
  }
});

it("classifies sandbox authority from its captured actor despite a different configured store", async () => {
  const { owner } = registry();
  const sessionKey = "agent:main:dashboard:incognito-workspace-policy";
  await actor.sessions.create(authority, {
    sessionKey,
    entry: {
      sessionId: "workspace-policy",
      updatedAt: 1,
      incognito: true,
      sandbox: "required",
    },
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
  const params = { config, agentId: "main", sessionKey, storePath: actor.path };
  const sql = observeHostDataSql();
  try {
    await withIncognitoSessionActor(actor, async () => {
      const expected = {
        sandboxed: true,
        workspaceAccess: "ro",
        confinementError: "target sandbox is not exclusive to this worker session.",
      };
      expect(owner.runtime.sandbox.resolveWorkspaceAuthority(params)).toEqual(expected);
      await expect(
        owner.runtime.sandbox.prepareWorkspaceAuthority({ ...params, workspaceDir: "/workspace" }),
      ).resolves.toEqual(expected);
    });
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
  }
});

it("rechecks delegated harness authority after admission waits", async () => {
  const { runtime, caller, harness } = registry();
  const key = "agent:main:dashboard:incognito-delegated";
  await actor.sessions.create(authority, {
    sessionKey: key,
    entry: {
      sessionId: "delegated",
      updatedAt: Date.now(),
      incognito: true,
      agentHarnessId: harness.id,
      modelSelectionLocked: true,
    },
  });
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const original = runtime.agent.session.runWithWorkAdmission;
  runtime.agent.session.runWithWorkAdmission = async (params, run) => {
    entered.resolve();
    await release.promise;
    return original(params, run);
  };
  const run = vi.fn(async () => "must-not-run");
  const sql = observeHostDataSql();
  try {
    const work = withIncognitoSessionActor(actor, () =>
      caller.runtime.agent.session.runWithWorkAdmission(
        {
          storePath: actor.path,
          sessionKey: key,
        },
        run,
      ),
    );
    const rejected = expect(work).rejects.toThrow('owned by plugin "owner"');
    await awaitGateBeforeSettlement(entered.promise, work, "delegated admission did not enter");
    harness.delegatedExecutionPluginIds.length = 0;
    release.resolve();
    await rejected;
    expect(run).not.toHaveBeenCalled();
    expect(sql.queries).toEqual([]);
  } finally {
    release.resolve();
    sql.restore();
  }
});

it.each(["finalize", "rollback", "changed" as const])(
  "%s retains the exact actor initializer",
  async (outcome) => {
    const { owner, harness } = registry();
    const key = `agent:main:dashboard:incognito-initialize-${outcome}`;
    const initialEntry = {
      agentHarnessId: harness.id,
      modelSelectionLocked: true as const,
      pluginExtensions: { test: { initializing: true } },
    };
    await actor.sessions.create(authority, {
      sessionKey: key,
      entry: {
        ...initialEntry,
        sessionId: `initialize-${outcome}`,
        updatedAt: Date.now(),
        incognito: true,
        initializationPending: true,
      },
    });
    const sql = observeHostDataSql();
    try {
      await withIncognitoSessionActor(actor, async () => {
        const creation = owner.runtime.agent.session.createSessionEntry({
          cfg: {},
          key,
          initialEntry,
          recoverMatchingInitialEntry: true,
          afterCreate: async ({ initialization }) => {
            if (!initialization) {
              throw new Error("session creation did not supply its initializer");
            }
            initialization.assertCurrent();
            if (outcome === "rollback") {
              throw new Error("initializer rejected");
            }
            if (outcome === "changed") {
              await owner.runtime.agent.session.patchSessionEntry({
                sessionKey: key,
                storePath: actor.path,
                update: () => ({ displayName: "concurrent owner" }),
              });
              initialization.assertCurrent();
            }
            return { pluginExtensions: { test: { initialized: true } } };
          },
        });
        if (outcome === "finalize") {
          await expect(creation).resolves.toMatchObject({
            entry: {
              initializationPending: undefined,
              pluginExtensions: { test: { initialized: true } },
            },
          });
        } else {
          await expect(creation).rejects.toThrow(
            outcome === "rollback" ? "initializer rejected" : "guarded rollback did not complete",
          );
        }
        const stored = await owner.runtime.agent.session.getSessionEntryAsync({
          sessionKey: key,
          storePath: actor.path,
        });
        if (outcome === "rollback") {
          expect(stored).toBeUndefined();
        }
        if (outcome === "changed") {
          expect(stored?.displayName).toBe("concurrent owner");
        }
      });
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
  },
);

it("hands explicit bound creation to the existing Gateway creator", async () => {
  const { owner, harness } = registry();
  const create = vi
    .spyOn(gatewayCreation, "createGatewaySession")
    .mockRejectedValue(new Error("creator refused"));
  const key = "agent:main:dashboard:incognito-plugin-create";
  const sql = observeHostDataSql();
  try {
    await expect(
      withIncognitoSessionActor(actor, () =>
        owner.runtime.agent.session.createSessionEntry({
          cfg: {},
          key,
          initialEntry: { agentHarnessId: harness.id, modelSelectionLocked: true },
        }),
      ),
    ).rejects.toThrow("creator refused");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ key, incognito: true, authorizedAgentHarnessId: harness.id }),
    );
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
  }
});
