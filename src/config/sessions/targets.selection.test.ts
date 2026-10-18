import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  resolveConfiguredAgentDatabaseCandidatePaths,
  resolveConfiguredAgentDatabaseTargets,
  resolveSessionStoreTargets,
} from "./targets.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("session store target selection", () => {
  it.each(["default", "template", "fixed", "shared"] as const)(
    "selects one database owner without changing %s store ownership",
    (layout) => {
      const root = tempDirs.make("configured-database-selection-");
      const env = { OPENCLAW_STATE_DIR: root };
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: { first: {}, second: {} },
          defaults: { sessionStore: { agentId: "first" } },
        },
        acp: { allowedAgents: ["acp-only"] },
        ...(layout === "default"
          ? {}
          : {
              session: {
                store: path.join(
                  root,
                  layout === "template" ? "{agentId}" : "fixed",
                  layout === "shared" ? "shared.sqlite" : "sessions.json",
                ),
              },
            }),
      };
      const firstDatabase = path.join(root, "agents", "first", "agent", "openclaw-agent.sqlite");
      const secondDatabase = path.join(root, "agents", "second", "agent", "openclaw-agent.sqlite");
      const expectedPaths = {
        default: {
          first: [firstDatabase],
          second: [secondDatabase],
          "acp-only": [path.join(root, "agents", "acp-only", "agent", "openclaw-agent.sqlite")],
        },
        template: {
          first: [path.join(root, "first", "openclaw-agent.sqlite"), firstDatabase],
          second: [path.join(root, "second", "openclaw-agent.second.sqlite"), secondDatabase],
          "acp-only": [path.join(root, "acp-only", "openclaw-agent.acp-only.sqlite")],
        },
        fixed: {
          first: [path.join(root, "fixed", "openclaw-agent.sqlite"), firstDatabase],
          second: [path.join(root, "fixed", "openclaw-agent.second.sqlite"), secondDatabase],
          "acp-only": [path.join(root, "fixed", "openclaw-agent.acp-only.sqlite")],
        },
        shared: {
          first: [path.join(root, "fixed", "shared.sqlite"), firstDatabase],
          second: [secondDatabase],
          "acp-only": [],
        },
      };
      const expected = Object.entries(expectedPaths[layout]).flatMap(([agentId, paths]) =>
        paths.map((pathname) => ({ agentId, path: pathname })),
      );
      for (const agentId of ["openclaw", "crestodian"]) {
        expect(
          resolveConfiguredAgentDatabaseTargets(cfg, { env, registeredDatabases: [], agentId }),
        ).toEqual([]);
        const databasePath = path.join(root, "agents", agentId, "agent", "openclaw-agent.sqlite");
        fs.mkdirSync(path.dirname(databasePath), { recursive: true });
        fs.writeFileSync(databasePath, "synthetic file identity; no database reads");
        expected.push({
          agentId,
          path: databasePath,
        });
      }
      const all = resolveConfiguredAgentDatabaseTargets(cfg, { env, registeredDatabases: [] });
      expect(all).toHaveLength(expected.length);
      expect(all).toEqual(expect.arrayContaining(expected));
      for (const agentId of ["first", "second", "acp-only", "openclaw", "crestodian", "missing"]) {
        expect(
          resolveConfiguredAgentDatabaseTargets(cfg, { env, registeredDatabases: [], agentId }),
        ).toEqual(expected.filter((target) => target.agentId === agentId));
      }
    },
  );

  it("retains unreadable reserved native paths for admission diagnostics", () => {
    const root = tempDirs.make("unreadable-system-database-");
    const env = { OPENCLAW_STATE_DIR: root };
    const cfg = { agents: { entries: { main: {} } } };
    const databasePath = path.join(root, "agents", "openclaw", "agent", "openclaw-agent.sqlite");
    const lstatSync = fs.lstatSync;
    using probe = vi.spyOn(fs, "lstatSync");
    probe.mockImplementation((...args) => {
      if (args[0] === databasePath) {
        throw Object.assign(new Error("synthetic access denial"), { code: "EACCES" });
      }
      return lstatSync(...args);
    });

    expect(resolveConfiguredAgentDatabaseCandidatePaths(cfg, { env })).toContain(databasePath);
    expect(
      resolveConfiguredAgentDatabaseTargets(cfg, {
        env,
        registeredDatabases: [],
        agentId: "openclaw",
      }),
    ).toEqual([{ agentId: "openclaw", path: databasePath }]);
  });

  it("rejects a blank agent instead of selecting the default store", () => {
    expect(() => resolveSessionStoreTargets({}, { agent: "" })).toThrow(
      "--agent must not be blank",
    );
  });

  it.each([
    ["empty", ""],
    ["whitespace-only", "   "],
  ])("rejects an %s store instead of selecting the default store", (_label, store) => {
    expect(() => resolveSessionStoreTargets({}, { store })).toThrow("--store must not be blank");
  });
});
