import "./subagent-spawn-model.mocks.shared.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { installSpawnAuthorityFixture } from "./subagent-spawn.authority.test-support.js";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  getAcpSessionManager,
  testing as managerTesting,
} from "../../../acp/control-plane/manager.js";
import { disposeAcpSessionManagerInstance } from "../../../acp/control-plane/manager.lifecycle.js";
import {
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "../../../acp/runtime/registry.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
} from "../../../config/config.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntrySync,
} from "../../../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../../../config/sessions/session-accessor.sqlite-entry-store.js";
import { LegacyContextEngine } from "../../../context-engine/legacy.js";
import { runOpenClawAgentWriteTransaction } from "../../../state/openclaw-agent-db.js";
import { normalizeSessionDeliveryState } from "../../../utils/delivery-context.shared.js";
import { maybeSpawnVisibleSession } from "../../tools/sessions-spawn-visible.js";
import {
  settleSubagentRegistryPersistenceWork,
  writeSubagentSessionEntry,
} from "../registry/subagent-registry.persistence.test-support.js";
import { loadSubagentRegistryFromSqlite } from "../registry/subagent-registry.store.sqlite.js";
import { spawnAcpDirect } from "./acp-spawn.js";
import { spawnSubagentDirect } from "./subagent-spawn.js";
import { testing as spawnTesting } from "./subagent-spawn.test-support.js";

const fixture = installSpawnAuthorityFixture();
const backendId = "requester-incarnation-fixture";

it("rejects a spawn cancelled during requester acquisition before starting effects", async () => {
  await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: fixture.parentSessionKey,
    defaultSessionId: "cancelled-requester",
  });
  const abort = new AbortController();
  const effectsStarted = vi.fn();
  const pending = spawnSubagentDirect(
    { task: "cancel before admission", context: "isolated" },
    {
      agentSessionKey: fixture.parentSessionKey,
      assertActive: () => abort.signal.throwIfAborted(),
      onSpawnEffectsStart: effectsStarted,
    },
  );
  abort.abort(new Error("requester acquisition cancelled"));
  expect(await pending).toEqual({
    status: "error",
    error: "sessions_spawn could not read the requester session: requester acquisition cancelled",
  });
  expect(effectsStarted).not.toHaveBeenCalled();
});

it("reads the requester off-thread while retaining dirty-sibling validation", async () => {
  const sibling = "agent:main:matrix:channel:!mixed:example.org";
  const database = runOpenClawAgentWriteTransaction(
    (writer) => {
      for (const sessionKey of [fixture.parentSessionKey, sibling]) {
        writeSessionEntry(writer, sessionKey, { sessionId: sessionKey, updatedAt: 1 });
      }
      return writer;
    },
    { agentId: "main" },
  );
  const readRequester = () =>
    spawnSubagentDirect(
      { task: "capture requester", context: "isolated", groupId: "requires-collect" },
      { agentSessionKey: fixture.parentSessionKey },
    );
  getRuntimeConfig();
  const sql = observeHostDataSql();
  try {
    expect(await readRequester()).toEqual({
      status: "error",
      error: "sessions_spawn groupId requires collect=true.",
    });
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
  }
  database.db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?").run(
    JSON.stringify({
      sessionId: sibling,
      updatedAt: 1,
      delivery: normalizeSessionDeliveryState({
        context: { channel: "matrix", to: "!Mixed:example.org" },
      }),
    }),
    sibling,
  );
  database.db
    .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
    .run(sibling);
  expect(await readRequester()).toMatchObject({
    status: "error",
    error: expect.stringContaining("non-canonical persisted row"),
  });
});

it.each([
  { backend: "native", originalSessionId: "original-requester", globalRequester: false },
  { backend: "acp", originalSessionId: "original-requester", globalRequester: false },
  { backend: "native", originalSessionId: undefined, globalRequester: false },
  { backend: "visible", originalSessionId: "original-requester", globalRequester: true },
] as const)(
  "keeps the birth requester window through async $backend launch (original=$originalSessionId, global=$globalRequester)",
  async ({ backend, originalSessionId, globalRequester }) => {
    const requesterSessionKey = globalRequester ? "global" : "agent:main:completion-owner";
    const originalLifecycleRevision = originalSessionId
      ? "original-requester-lifecycle"
      : undefined;
    const replacementLifecycleRevision = "replacement-requester-lifecycle";
    if (globalRequester) {
      const cfg = getRuntimeConfig();
      await writeFile(
        path.join(fixture.stateDir, "openclaw.json"),
        JSON.stringify({
          ...cfg,
          session: { ...cfg.session, scope: "global" },
          agents: {
            ...cfg.agents,
            ownership: "explicit",
            entries: { main: { subagents: { allowAgents: ["worker"] } }, worker: {} },
          },
        }),
      );
      clearConfigCache();
      clearRuntimeConfigSnapshot();
      await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "worker",
        sessionKey: "global",
        defaultSessionId: "foreign-child-owner",
      });
    }
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: fixture.parentSessionKey,
      defaultSessionId: "controller-session",
    });
    if (originalSessionId) {
      await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey: requesterSessionKey,
        defaultSessionId: originalSessionId,
        lifecycleRevision: originalLifecycleRevision,
      });
    }
    if (backend === "acp") {
      const cfg = getRuntimeConfig();
      await writeFile(
        path.join(fixture.stateDir, "openclaw.json"),
        JSON.stringify({
          ...cfg,
          acp: { enabled: true, backend: backendId, allowedAgents: ["main"] },
          agents: {
            ...cfg.agents,
            defaults: { ...cfg.agents?.defaults, model: undefined },
          },
        }),
      );
      clearConfigCache();
      clearRuntimeConfigSnapshot();
      managerTesting.resetAcpSessionManagerForTests();
      const runtime: AcpRuntime = {
        ownerAwareSessions: 1,
        async ensureSession(input) {
          return {
            sessionKey: input.sessionKey,
            agentId: input.agentId,
            backend: backendId,
            runtimeSessionName: input.sessionKey,
            backendSessionId: `fixture:${input.sessionKey}`,
          };
        },
        runTurn() {
          throw new Error("No external harness turn belongs in this boundary test");
        },
        async cancel() {},
        async close() {},
      };
      registerAcpRuntimeBackend({ id: backendId, runtime });
    }
    spawnTesting.setDepsForTest({
      hasInProcessGatewayContext: () => true,
      resolveContextEngine: async () => new LegacyContextEngine(),
      dispatchGatewayMethodInProcess: async <T>(
        method: string,
        params: Record<string, unknown>,
      ) => {
        if (method !== "agent") {
          throw new Error(`Unexpected spawn RPC ${method}`);
        }
        return { runId: params.idempotencyKey, status: "accepted" } as T;
      },
    });
    const rotateRequester = vi.fn(() => {
      // Rotate after requester capture and before child creation; completion
      // must retain that captured window even when later launch steps await.
      replaceSessionEntrySync(
        { sessionKey: requesterSessionKey, agentId: "main" },
        {
          sessionId: "replacement-requester",
          lifecycleRevision: replacementLifecycleRevision,
          updatedAt: Date.now(),
        },
      );
    });
    const ctx = {
      agentSessionKey: fixture.parentSessionKey,
      completionOwnerKey: requesterSessionKey,
      onSpawnEffectsStart: rotateRequester,
      ...(globalRequester ? { requesterAgentIdOverride: "main" } : {}),
    };
    try {
      const pending =
        backend === "native"
          ? spawnSubagentDirect({ task: "window-bound work", context: "isolated" }, ctx)
          : backend === "acp"
            ? spawnAcpDirect({ task: "window-bound work", agentId: "main", mode: "run" }, ctx)
            : maybeSpawnVisibleSession({
                raw: { visible: true },
                ...(globalRequester ? { agentId: "worker" } : {}),
                task: "window-bound work",
                label: "",
                runtime: "subagent",
                sandbox: "inherit",
                expectsCompletionMessage: true,
                options: {
                  ...ctx,
                  config: getRuntimeConfig(),
                  callGateway: async <T>(method: string) => {
                    if (method !== "sessions.create") {
                      throw new Error(`Unexpected visible spawn RPC ${method}`);
                    }
                    const childAgentId = globalRequester ? "worker" : "main";
                    const childSessionKey = `agent:${childAgentId}:dashboard:window-child`;
                    await writeSubagentSessionEntry({
                      stateDir: fixture.stateDir,
                      agentId: childAgentId,
                      sessionKey: childSessionKey,
                      defaultSessionId: "visible-child-session",
                    });
                    return {
                      key: childSessionKey,
                      sessionId: "visible-child-session",
                      runStarted: true,
                      runId: "visible-child-run",
                    } as T;
                  },
                },
              });
      const result = await pending;
      expect(result).toMatchObject({ status: "accepted" });
      expect(rotateRequester).toHaveBeenCalled();
      const runId = result?.runId;
      if (typeof runId !== "string") {
        throw new Error("Expected an accepted child run");
      }
      await settleSubagentRegistryPersistenceWork();
      const restored = loadSubagentRegistryFromSqlite().get(runId);
      expect(restored).toMatchObject({
        runId,
        requesterSessionKey,
        controllerSessionKey: fixture.parentSessionKey,
        expectsCompletionMessage: true,
      });
      expect(restored?.completionRequesterSessionId).toBe(originalSessionId);
      expect(restored?.completionRequesterLifecycleRevision).toBe(originalLifecycleRevision);
      expect(
        loadSessionEntryReadOnly({ sessionKey: requesterSessionKey, agentId: "main" }),
      ).toMatchObject({
        sessionId: "replacement-requester",
        lifecycleRevision: replacementLifecycleRevision,
      });
    } finally {
      if (backend === "acp") {
        await disposeAcpSessionManagerInstance(getAcpSessionManager(), "test-cleanup");
        managerTesting.resetAcpSessionManagerForTests();
        unregisterAcpRuntimeBackend(backendId);
      }
    }
  },
);
