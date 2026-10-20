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
      const expected = [
        "first",
        "second",
        "openclaw",
        "crestodian",
        ...(layout === "default" ? ["acp-only"] : []),
      ].map((agentId) => ({
        agentId,
        path: path.join(root, "agents", agentId, "agent", "openclaw-agent.sqlite"),
      }));
      const configured: readonly (readonly [string, string])[] =
        layout === "shared"
          ? [["first", "shared.sqlite"]]
          : [
              ["first", "openclaw-agent.sqlite"],
              ["second", "openclaw-agent.second.sqlite"],
              ["acp-only", "openclaw-agent.acp-only.sqlite"],
            ];
      if (layout !== "default") {
        expected.unshift(
          ...configured.map(([agentId, filename]) => ({
            agentId,
            path: path.join(root, layout === "template" ? agentId : "fixed", filename),
          })),
        );
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

  it.each([
    ["agent", ""],
    ["store", ""],
    ["store", "   "],
  ] as const)("rejects blank --%s (%j) instead of defaulting", (option, value) => {
    expect(() => resolveSessionStoreTargets({}, { [option]: value })).toThrow(
      `--${option} must not be blank`,
    );
  });
});
