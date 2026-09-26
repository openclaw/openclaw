import fs from "node:fs";
import path from "node:path";
import { StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import * as sessionAccessor from "../../../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../../../config/sessions/session-accessor.sqlite-entry-store.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { createDirectChatContext } from "../../../gateway/server-chat.agent-events.test-helpers.js";
import {
  bindSessionRowProjection,
  getSessionRowProjection,
} from "../../../gateway/session-row-projection-access.js";
import { createSessionRowProjection } from "../../../gateway/session-row-projection.js";
import { withPluginRuntimeGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  closeOpenClawAgentDatabasesAsync,
  runOpenClawAgentWriteTransaction,
} from "../../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { resolveRequesterToolPolicies } from "../../requester-tool-policy.js";
import {
  isSubagentEnvelopeSession,
  resolveStoredSubagentCapabilities,
  resolveStoredSubagentInheritedToolAllowlist,
  resolveStoredSubagentInheritedToolDenylist,
  resolveSubagentCapabilityStore,
} from "./subagent-capabilities.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import { createSubagentSessionStore } from "./subagent-session-store.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.dirs) {
      await closeOpenClawAgentDatabasesAsync(dir);
    }
    cleanup();
  }),
);

describe("persisted subagent capability lookups", () => {
  it.each([false, true])(
    "resolves current requester policy without session SQL (default store: %s)",
    async (useDefault) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const storePath = useDefault
          ? resolveSessionStorePathCore(undefined, { agentId: "main" })
          : state.statePath("capabilities.sqlite");
        const cfg = useDefault ? {} : { session: { store: storePath } };
        const key = "agent:main:dashboard:resident-capabilities";
        const scope = { agentId: "main", storePath, sessionKey: key };
        await sessionAccessor.upsertSessionEntryCore(
          { ...scope, sessionKey: "agent:main:main" },
          { sessionId: "parent", updatedAt: 1 },
        );
        await sessionAccessor.upsertSessionEntryCore(scope, {
          sessionId: "resident-child",
          updatedAt: 1,
          spawnedBy: "agent:main:main",
          spawnDepth: 2,
          inheritedToolPolicyVersion: 1,
          inheritedToolAllow: ["read"],
          inheritedToolDeny: ["exec"],
        });
        const projection = await createSessionRowProjection({ cfg });
        try {
          await projection.ensureMaterialized();
          const context = bindSessionRowProjection(
            createDirectChatContext({ getRuntimeConfig: () => cfg }),
            () => projection,
          );
          const copied = { ...context };
          let retired = false;
          await withPluginRuntimeGatewayContextResolver(
            () => {
              if (retired) {
                throw new Error("Gateway owner retired");
              }
              return copied;
            },
            async () => {
              const resolve = () =>
                resolveRequesterToolPolicies({ config: cfg, agentId: "main", sessionKey: key });
              expect(resolve().inheritedToolPolicy).toEqual({ allow: ["read"], deny: ["exec"] });
              const queries = observeSqliteReadSql(StatementSync.prototype);
              try {
                for (let turn = 0; turn < 50; turn += 1) {
                  const policy = resolve();
                  expect(policy.inheritedToolPolicy).toEqual({ allow: ["read"], deny: ["exec"] });
                  expect(
                    resolveStoredSubagentCapabilities(key, { cfg, store: policy.subagentStore })
                      .depth,
                  ).toBe(2);
                }
                expect(queries.queries).toHaveLength(0);
              } finally {
                queries.restore();
              }
              await sessionAccessor.patchSessionEntryCore(scope, () => ({
                spawnDepth: 3,
                inheritedToolDeny: ["exec", "write"],
              }));
              const current = resolve();
              expect(current.inheritedToolPolicy).toEqual({
                allow: ["read"],
                deny: ["exec", "write"],
              });
              expect(
                resolveStoredSubagentCapabilities(key, { cfg, store: current.subagentStore }).depth,
              ).toBe(3);

              // Rebinding a context updates its copies; rebinding a copy creates a separate owner.
              bindSessionRowProjection(context, () => undefined);
              expect(getSessionRowProjection(copied)).toBeUndefined();
              bindSessionRowProjection(copied, () => projection);
              expect(getSessionRowProjection(context)).toBeUndefined();
              expect(getSessionRowProjection(copied)).toBe(projection);

              const exact = vi.spyOn(sessionAccessor, "loadExactSessionEntryReadOnly");
              expect(createSubagentSessionStore(storePath, "main").get("main")).toBeUndefined();
              expect(
                resolveRequesterToolPolicies({
                  config: { session: { store: state.statePath("absent.sqlite") } },
                  sessionKey: key,
                }).delegated,
              ).toBe(false);
              expect(exact).toHaveBeenCalledTimes(2);
              exact.mockRestore();
              retired = true;
              expect(resolve).toThrow("Gateway owner retired");
            },
          );
        } finally {
          projection.dispose();
        }
      });
    },
  );

  it("memoizes exact reads and misses only within one capability resolution", () => {
    const storePath = path.join(tempDirs.make("subagent-capability-memo-"), "sessions.sqlite");
    const cfg = { session: { store: storePath } };
    const key = "agent:main:subagent:child";
    const write = (spawnDepth: number) =>
      runOpenClawAgentWriteTransaction(
        (database) => {
          writeSessionEntry(database, key, {
            sessionId: "child",
            updatedAt: 1,
            spawnDepth,
            inheritedToolDeny: ["exec"],
          });
        },
        { agentId: "main", path: storePath },
      );
    write(2);
    const exact = vi.spyOn(sessionAccessor, "loadExactSessionEntryReadOnly");
    const byId = vi.spyOn(sessionAccessor, "loadSessionEntryByIdReadOnly");
    const store = resolveSubagentCapabilityStore(key, { cfg });
    expect(exact).not.toHaveBeenCalled();
    for (let i = 0; i < 2; i++) {
      expect(resolveStoredSubagentCapabilities(key, { cfg, store }).depth).toBe(2);
      expect(resolveStoredSubagentInheritedToolDenylist(key, { cfg, store })).toEqual(["exec"]);
      expect(
        resolveStoredSubagentCapabilities("agent:main:subagent:missing", { cfg, store }).depth,
      ).toBe(1);
    }
    expect(exact).toHaveBeenCalledTimes(2);
    expect(byId).toHaveBeenCalledTimes(1);
    write(4);
    expect(resolveStoredSubagentCapabilities(key, { cfg }).depth).toBe(4);
    expect(exact).toHaveBeenCalledTimes(3);
  });

  it.each([true, false])(
    "binds prepared facts to the exact session key (matching=%s)",
    (matching) => {
      const storePath = path.join(
        tempDirs.make("subagent-capability-prepared-"),
        "sessions.sqlite",
      );
      const cfg = { session: { store: storePath } };
      const key = "agent:main:subagent:child";
      const exact = vi.spyOn(sessionAccessor, "loadExactSessionEntryReadOnly");
      const store = resolveSubagentCapabilityStore(key, {
        cfg,
        preparedSessionEntry: {
          sessionKey: matching ? key : "agent:main:subagent:other",
          entry: { sessionId: "child", spawnDepth: 3, inheritedToolDeny: ["exec"] },
        },
      });
      expect(resolveStoredSubagentCapabilities(key, { cfg, store }).depth).toBe(matching ? 3 : 1);
      expect(resolveStoredSubagentInheritedToolDenylist(key, { cfg, store })).toEqual(
        matching ? ["exec"] : [],
      );
      expect(exact).toHaveBeenCalledTimes(matching ? 0 : 1);
      expect(fs.existsSync(storePath)).toBe(false);
    },
  );

  it("keeps canonical depth fallback for a partial explicit record", () => {
    const storePath = path.join(tempDirs.make("subagent-capability-partial-"), "sessions.sqlite");
    const cfg = { session: { store: storePath } };
    const key = "agent:main:subagent:child";
    runOpenClawAgentWriteTransaction(
      (database) => {
        writeSessionEntry(database, key, { sessionId: "child", updatedAt: 1, spawnDepth: 3 });
      },
      { agentId: "main", path: storePath },
    );
    expect(
      resolveStoredSubagentCapabilities(key, {
        cfg,
        store: { [key]: { spawnedBy: "agent:main:main" } },
      }).depth,
    ).toBe(3);
  });

  it.each(["", " ", "\t\r\n", "\u00a0\u2003\u2028\ufeff"])(
    "matches explicit stores for nested and by-id lineage without listing unrelated sessions (padding=%j)",
    (padding) => {
      const storePath = path.join(tempDirs.make("subagent-capability-lookup-"), "sessions.sqlite");
      const cfg = { session: { store: storePath } };
      const root = "agent:main:main";
      const parent = "agent:main:subagent:parent";
      const child = "agent:main:subagent:child";
      const acp = "agent:main:acp:resumed";
      const dashboard = "agent:main:dashboard:spawned";
      const byId = "agent:main:subagent:by-id";
      const cycle = "agent:main:acp:cycle-one";
      const store: Record<string, SessionEntry> = {
        [root]: { sessionId: "root", updatedAt: 1, spawnDepth: 0 },
        [parent]: { sessionId: "parent-id", updatedAt: 1, spawnedBy: root },
        [child]: { sessionId: `${padding}child-id${padding}`, updatedAt: 1, spawnedBy: parent },
        "agent:main:subagent:renamed": {
          sessionId: `${padding}${byId}${padding}`,
          updatedAt: 1,
          spawnedBy: child,
          inheritedToolAllow: ["read"],
          inheritedToolDeny: ["exec"],
        },
        [acp]: {
          sessionId: "acp-id",
          updatedAt: 1,
          spawnedBy: child,
          inheritedToolAllow: ["read"],
          inheritedToolDeny: ["exec"],
        },
        [dashboard]: { sessionId: "dashboard-id", updatedAt: 1, spawnDepth: 4, spawnedBy: acp },
        [cycle]: { sessionId: "cycle-one", updatedAt: 1, spawnedBy: "agent:main:acp:cycle-two" },
        "agent:main:acp:cycle-two": { sessionId: "cycle-two", updatedAt: 1, spawnedBy: cycle },
      };
      runOpenClawAgentWriteTransaction(
        (database) => {
          for (const [key, entry] of Object.entries(store)) {
            writeSessionEntry(database, key, entry);
          }
          for (let i = 0; i < 64; i++) {
            writeSessionEntry(database, `agent:main:dashboard:unrelated-${i}`, {
              sessionId: `unrelated-${i}`,
              updatedAt: 1,
              skillsSnapshot: { prompt: "unrelated saved prompt", skills: [] },
            });
          }
        },
        { agentId: "main", path: storePath },
      );
      const listing = vi.spyOn(sessionAccessor, "listSessionEntriesReadOnly");
      for (const key of [parent, child, acp, dashboard, byId, "child-id", cycle]) {
        const persisted = resolveSubagentCapabilityStore(key, { cfg });
        expect(resolveStoredSubagentCapabilities(key, { cfg, store: persisted })).toEqual(
          resolveStoredSubagentCapabilities(key, { store }),
        );
        expect(getSubagentDepthFromSessionStore(key, { cfg, store: persisted })).toBe(
          getSubagentDepthFromSessionStore(key, { store }),
        );
        if (key !== "child-id") {
          expect(isSubagentEnvelopeSession(key, { cfg, store: persisted })).toBe(
            isSubagentEnvelopeSession(key, { store }),
          );
          expect(
            resolveStoredSubagentInheritedToolAllowlist(key, { cfg, store: persisted }),
          ).toEqual(resolveStoredSubagentInheritedToolAllowlist(key, { store }));
          expect(
            resolveStoredSubagentInheritedToolDenylist(key, { cfg, store: persisted }),
          ).toEqual(resolveStoredSubagentInheritedToolDenylist(key, { store }));
        }
      }
      expect(
        resolveStoredSubagentCapabilities("child-id", {
          cfg: { ...cfg, agents: { defaults: { subagents: { maxSpawnDepth: 2 } } } },
        }),
      ).toMatchObject({ depth: 2, role: "leaf", canSpawn: false, canControlChildren: false });
      expect(listing).not.toHaveBeenCalled();
    },
  );
});
