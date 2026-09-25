import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import * as sessionAccessor from "../../../config/sessions/session-accessor.js";
import * as sessionAvailability from "../../../config/sessions/session-accessor.sqlite-entry-availability.js";
import { writeSessionEntry } from "../../../config/sessions/session-accessor.sqlite-entry-store.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import {
  closeOpenClawAgentDatabasesAsync,
  runOpenClawAgentWriteTransaction,
} from "../../../state/openclaw-agent-db.js";
import {
  isSubagentEnvelopeSession,
  resolvePersistedSubagentToolPolicyEnvelope,
  resolveStoredSubagentCapabilities,
  resolveStoredSubagentInheritedToolAllowlist,
  resolveStoredSubagentInheritedToolDenylist,
  resolveSubagentCapabilityStore,
} from "./subagent-capabilities.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";

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
  it("keeps unrelated corrupt rows outside exact policy admission", () => {
    const storePath = path.join(tempDirs.make("subagent-policy-exact-"), "sessions.sqlite");
    const key = "agent:main:subagent:child";
    const corruptKey = "agent:main:subagent:corrupt";
    runOpenClawAgentWriteTransaction(
      (database) => {
        writeSessionEntry(database, key, {
          sessionId: "child",
          updatedAt: 1,
          spawnedBy: "agent:main:parent",
          spawnDepth: 1,
          inheritedToolPolicyVersion: 1,
          inheritedToolAllow: ["read"],
        });
        database.db
          .prepare(
            "INSERT INTO session_nodes(session_key, current_session_id, entry_json, updated_at) VALUES (?, 'corrupt', '{broken', 1)",
          )
          .run(corruptKey);
      },
      { agentId: "main", path: storePath },
    );
    const cfg = { session: { store: storePath } };
    expect(resolvePersistedSubagentToolPolicyEnvelope(key, { cfg })).toMatchObject({
      version: 1,
      inheritedToolAllow: ["read"],
    });
    expect(() => resolvePersistedSubagentToolPolicyEnvelope(corruptKey, { cfg })).toThrow(
      "Inherited tool policy could not be read from its session owner",
    );
  });

  it.each([
    { inheritedToolPolicyVersion: 3 },
    { inheritedToolPolicy: {} },
    { inheritedToolPolicyVersion: 2 },
    { inheritedToolPolicyVersion: 2, spawnedBy: undefined },
    { inheritedToolPolicyVersion: 2, completionOwnerSessionKey: undefined },
    { inheritedToolPolicyVersion: 2, inheritedToolDeny: ["exec"] },
  ])("rejects an unsupported or incomplete persisted policy: %j", (patch) => {
    const key = "agent:main:subagent:child";
    expect(() =>
      resolvePersistedSubagentToolPolicyEnvelope(key, {
        store: {
          [key]: {
            sessionId: "child",
            spawnDepth: 1,
            spawnedBy: "agent:main:parent",
            completionOwnerSessionKey: "agent:main:parent",
            ...patch,
          },
        },
      }),
    ).toThrow();
  });

  it("does not turn a lost expected v2 row or an unavailable owner into legacy fallback", () => {
    const key = "agent:main:subagent:child";
    expect(() =>
      resolvePersistedSubagentToolPolicyEnvelope(key, { store: {}, requiredVersion: 2 }),
    ).toThrow("Expected inherited tool policy v2 is unavailable");
    const cfg = {
      session: {
        store: path.join(tempDirs.make("subagent-policy-unavailable-"), "sessions.sqlite"),
      },
    };
    expect(() => resolvePersistedSubagentToolPolicyEnvelope(key, { cfg })).toThrow(
      "Inherited tool policy could not be read from its session owner",
    );
    const unavailable = new Error("Owner database is unavailable");
    vi.spyOn(sessionAvailability, "loadExactSessionEntryReadOnlyResult").mockImplementation(() => {
      throw unavailable;
    });
    vi.spyOn(sessionAccessor, "loadSessionEntryByIdReadOnly").mockImplementation(() => {
      throw unavailable;
    });
    const store = resolveSubagentCapabilityStore(key, { cfg });
    expect(resolveStoredSubagentCapabilities(key, { cfg, store }).depth).toBe(1);
    expect(() => resolvePersistedSubagentToolPolicyEnvelope(key, { cfg, store })).toThrow(
      "Inherited tool policy could not be read from its session owner",
    );
  });

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
    const exact = vi.spyOn(sessionAvailability, "loadExactSessionEntryReadOnlyResult");
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
    expect(
      resolvePersistedSubagentToolPolicyEnvelope("agent:main:subagent:missing", { cfg, store }),
    ).toBeUndefined();
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
      const exact = vi.spyOn(sessionAvailability, "loadExactSessionEntryReadOnlyResult");
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
