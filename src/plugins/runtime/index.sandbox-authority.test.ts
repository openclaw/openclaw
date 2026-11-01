import "../../test-utils/prepare-compiled-subprocesses.js";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
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
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";

const sandbox = vi.hoisted(() => ({ resolveSandboxContext: vi.fn() }));
// mock-isolation: suspend provisioning at its effect guard without a sandbox backend.
vi.mock("../../agents/sandbox/context.js", () => sandbox);
import { createPluginRuntime } from "./index.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "plugin-sandbox" });
});
afterEach(async () => {
  await state.cleanup();
  vi.restoreAllMocks();
  sandbox.resolveSandboxContext.mockReset();
});

it.each(["custom store without global config", "concurrent rename", "revoked policy"] as const)(
  "prepares workspace authority: %s",
  async (scenario) => {
    const custom = scenario === "custom store without global config";
    const revoked = scenario === "revoked policy";
    const config: OpenClawConfig = {
      agents: { defaults: { sandbox: { mode: "all", scope: "session", workspaceAccess: "rw" } } },
      tools: { elevated: { enabled: false }, sandbox: { tools: { allow: ["read"] } } },
      ...(custom
        ? { session: { store: path.join(state.stateDir, "custom", "sessions.sqlite") } }
        : {}),
    };
    const scope = {
      agentId: "main",
      sessionKey: custom ? "agent:main:custom-sandbox" : "agent:main:subagent:sandbox-policy",
      storePath:
        config.session?.store ??
        resolveOpenClawAgentSqlitePath({ agentId: "main", env: process.env }),
    };
    setRuntimeConfigSnapshot(config);
    replaceSessionEntrySync(scope, {
      sessionId: "sandbox-policy",
      updatedAt: 1,
      ...(custom ? { sandboxMode: "off" as const } : {}),
    });
    if (custom) {
      clearRuntimeConfigSnapshot();
    }
    const runtime = createPluginRuntime();
    vi.spyOn(runtime.agent.session, "getSessionEntry").mockImplementation(() => {
      throw new Error("Sandbox preparation used the deprecated synchronous session reader");
    });
    const entered = createDeferredCore(),
      release = createDeferredCore();
    const provision = vi.fn(),
      dispose = vi.fn();
    let effectGuard: (() => void) | undefined;
    sandbox.resolveSandboxContext.mockImplementation(
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
      agentId: scope.agentId,
      sessionKey: scope.sessionKey,
      workspaceDir: state.workspaceDir,
      ...(!custom ? { storePath: scope.storePath } : {}),
    });
    const changedError = "Session workspace authority changed during sandbox preparation";
    const result = revoked
      ? expect(preparation).rejects.toThrow(changedError)
      : expect(preparation).resolves.toEqual({ sandboxed: !custom, workspaceAccess: "rw" });
    try {
      if (!custom) {
        await awaitGateBeforeSettlement(
          entered.promise,
          preparation,
          "sandbox preparation did not enter",
        );
        await patchSessionEntryCore(
          scope,
          () => (revoked ? { sandboxMode: "off" } : { displayName: "Renamed while preparing" }),
          { skipMaintenance: true },
        );
      }
    } finally {
      release.resolve();
    }
    await result;
    if (custom) {
      expect(sandbox.resolveSandboxContext).not.toHaveBeenCalled();
    } else {
      expect([provision.mock.calls.length, dispose.mock.calls.length]).toEqual(
        revoked ? [0, 0] : [1, 1],
      );
      expect(effectGuard).toBeTypeOf("function");
      expect(() => effectGuard!()).toThrow(changedError);
    }
  },
);
