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
        expected.push({
          agentId,
          path: path.join(root, "agents", agentId, "agent", "openclaw-agent.sqlite"),
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

  it("resolves reserved startup targets without probing their files", () => {
    const root = tempDirs.make("system-database-targets-");
    const env = { OPENCLAW_STATE_DIR: root };
    const cfg = { agents: { entries: { main: {} } } };
    const databasePath = path.join(root, "agents", "openclaw", "agent", "openclaw-agent.sqlite");
    using lstat = vi.spyOn(fs, "lstatSync");
    using stat = vi.spyOn(fs, "statSync");
    using realpath = vi.spyOn(fs.realpathSync, "native");

    expect(resolveConfiguredAgentDatabaseCandidatePaths(cfg, { env })).toContain(databasePath);
    expect(
      resolveConfiguredAgentDatabaseTargets(cfg, {
        env,
        registeredDatabases: [],
        agentId: "openclaw",
      }),
    ).toEqual([{ agentId: "openclaw", path: databasePath }]);
    for (const probe of [lstat, stat, realpath]) {
      expect(probe.mock.calls.filter(([pathname]) => pathname === databasePath)).toEqual([]);
    }
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
