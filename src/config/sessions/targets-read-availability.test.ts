import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import { replaceSessionEntry } from "./session-accessor.js";
import {
  resolveExistingAgentSessionStoreTargetsReadOnlyResult as readTargets,
  type SessionStoreTargetsReadCache,
} from "./targets-read-availability.worker.js";

afterEach(() => clearRuntimeConfigSnapshot());

const missingStoreConfig = (home: string): OpenClawConfig => ({
  session: { store: path.join(home, "custom", "{agentId}", "sessions.sqlite") },
});
const fixedStoreConfig = (store: string, owner = true): OpenClawConfig => ({
  session: { store },
  agents: {
    ownership: "explicit",
    ...(owner
      ? { defaults: { sessionStore: { agentId: "main" } }, entries: { main: {}, ops: {} } }
      : { entries: { ops: {}, research: {} } }),
  },
});
const write = (agentId: string, key = "main", updatedAt = 1, storePath?: string) =>
  replaceSessionEntry(
    { agentId, storePath, sessionKey: `agent:${agentId}:${key}` },
    { sessionId: key === "main" ? `${agentId}-session` : key, updatedAt },
  );

describe("session store availability", () => {
  it("uses admitted per-agent availability without probing session rows", async () => {
    await withTempHome(async () => {
      setRuntimeConfigSnapshot({});
      await write("main", "existing");
      const resolve = () => readTargets({}, "main");
      expect(resolve()).toMatchObject({ available: true, targets: [{ agentId: "main" }] });
      const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
      try {
        await write("main", "new", 2);
        prepare.mockClear();
        expect(resolve()).toMatchObject({ available: true, targets: [{ agentId: "main" }] });
        expect(
          prepare.mock.calls.filter(([query]) => /from\s+"?session_nodes\b/i.test(query)),
        ).toEqual([]);
      } finally {
        prepare.mockRestore();
      }
    });
  });

  it.each([true, false])("reads fixed-store rows (explicit default owner: %s)", async (owner) => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, owner ? "shared.sqlite" : "ownerless-shared.sqlite");
      const cfg = fixedStoreConfig(storePath, owner);
      setRuntimeConfigSnapshot(cfg);
      const agentIds = owner ? ["main", "ops"] : ["ops"];
      for (const agentId of agentIds) {
        await write(agentId, "main", 1, storePath);
      }
      const cache: SessionStoreTargetsReadCache = new Map();
      for (const agentId of agentIds) {
        expect(readTargets(cfg, agentId, { cache })).toEqual({
          available: true,
          targets: [{ agentId, storePath }],
        });
      }
      expect(cache.size).toBe(1);
    });
  });

  it.each([true, false])(
    "resolves a missing configured store (discovered sibling: %s)",
    async (discovered) => {
      await withTempHome(async (home) => {
        if (discovered) {
          setRuntimeConfigSnapshot({});
          await replaceSessionEntry(
            { agentId: "main", sessionKey: "agent:main:main" },
            { sessionId: "live-session", updatedAt: 1 },
          );
        }
        const cfg = missingStoreConfig(home);
        setRuntimeConfigSnapshot(cfg);
        const result = readTargets(cfg, "main");
        if (discovered) {
          // A false absence here would destroy live worker placements.
          expect(result.available).toBe(true);
          if (result.available) {
            expect(result.targets.length).toBeGreaterThan(0);
          }
        } else {
          expect(result).toEqual({ available: false, reason: "database-missing" });
        }
      });
    },
  );
});
