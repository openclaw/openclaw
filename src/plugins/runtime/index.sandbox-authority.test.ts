import "../../test-utils/prepare-compiled-subprocesses.js";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { resolveSandboxContext } from "../../agents/sandbox/context.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  patchSessionEntryCore,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";

const sandboxContextMocks = vi.hoisted(() => ({ resolveSandboxContext: vi.fn() }));
// mock-isolation: suspend provisioning at its effect guard without launching a sandbox backend.
vi.mock("../../agents/sandbox/context.js", () => sandboxContextMocks);

import { createPluginRuntime } from "./index.js";

const tempDirs = createTempDirTracker();

afterEach(async () => {
  for (const stateDir of tempDirs.dirs) {
    await cleanupSessionStateForTest({ stateDir });
  }
  tempDirs.cleanup();
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  sandboxContextMocks.resolveSandboxContext.mockReset();
});

it("uses the supplied session store without a prepared global config", async () => {
  const stateDir = tempDirs.make("plugin-sandbox-config-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const storePath = path.join(stateDir, "custom", "sessions.sqlite");
  const config: OpenClawConfig = {
    agents: { defaults: { sandbox: { mode: "all", workspaceAccess: "rw" } } },
    session: { store: storePath },
  };
  setRuntimeConfigSnapshot(config);
  const scope = { agentId: "main", sessionKey: "agent:main:custom-sandbox", storePath };
  replaceSessionEntrySync(scope, {
    sessionId: "custom-sandbox",
    updatedAt: 1,
    sandboxMode: "off",
  });
  clearRuntimeConfigSnapshot();

  await expect(
    createPluginRuntime().sandbox.prepareWorkspaceAuthority({
      config,
      agentId: scope.agentId,
      sessionKey: scope.sessionKey,
      workspaceDir: path.join(stateDir, "workspace"),
    }),
  ).resolves.toEqual({ sandboxed: false, workspaceAccess: "rw" });
  expect(sandboxContextMocks.resolveSandboxContext).not.toHaveBeenCalled();
});

it.each([false, true])(
  "checks published session policy at the sandbox effect without synchronous SQL (changed=%s)",
  async (changed) => {
    const stateDir = tempDirs.make("plugin-sandbox-authority-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const config: OpenClawConfig = {
      agents: {
        defaults: { sandbox: { mode: "all", scope: "session", workspaceAccess: "rw" } },
        entries: { main: { workspace: "/workspace" } },
      },
      tools: { elevated: { enabled: false }, sandbox: { tools: { allow: ["read"] } } },
    };
    setRuntimeConfigSnapshot(config);
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:subagent:sandbox-policy",
      storePath: resolveOpenClawAgentSqlitePath({ agentId: "main", env: process.env }),
    };
    replaceSessionEntrySync(scope, { sessionId: "sandbox-policy", updatedAt: 1 });
    const runtime = createPluginRuntime();
    vi.spyOn(runtime.agent.session, "getSessionEntry").mockImplementation(() => {
      throw new Error("Sandbox preparation used the deprecated synchronous session reader");
    });
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const provision = vi.fn();
    const dispose = vi.fn();
    let effectGuard: (() => void) | undefined;
    sandboxContextMocks.resolveSandboxContext.mockImplementation(
      async (params: Parameters<typeof resolveSandboxContext>[0]) => {
        effectGuard = params.assertCurrent;
        entered.resolve();
        await release.promise;
        const sql = observeHostDataSql();
        try {
          params.assertCurrent?.();
          provision();
          return { backendId: "docker", [Symbol.dispose]: dispose };
        } finally {
          expect(sql.queries).toEqual([]);
          sql.restore();
        }
      },
    );
    const preparation = runtime.sandbox.prepareWorkspaceAuthority({
      config,
      ...scope,
      workspaceDir: "/workspace",
    });
    const result = changed
      ? expect(preparation).rejects.toThrow(
          "Session workspace authority changed during sandbox preparation",
        )
      : expect(preparation).resolves.toEqual({ sandboxed: true, workspaceAccess: "rw" });
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        preparation,
        "sandbox preparation did not enter",
      );
      await patchSessionEntryCore(
        scope,
        () => (changed ? { sandboxMode: "off" } : { displayName: "Renamed while preparing" }),
        { skipMaintenance: true },
      );
    } finally {
      release.resolve();
    }
    await result;
    expect(provision).toHaveBeenCalledTimes(changed ? 0 : 1);
    expect(dispose).toHaveBeenCalledTimes(changed ? 0 : 1);
    expect(effectGuard).toBeTypeOf("function");
    expect(() => effectGuard!()).toThrow(
      "Session workspace authority changed during sandbox preparation",
    );
  },
);
