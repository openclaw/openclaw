import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  resolveConfiguredAgentDatabaseCandidatePaths as databaseCandidates,
  resolveConfiguredAgentDatabaseTargets as databaseTargets,
  resolveSessionStoreTargets as selectStores,
} from "./targets.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
it.each([
  ["default", undefined],
  ["template", "{agentId}/sessions.json"],
  ["fixed", "fixed/sessions.json"],
  ["shared", "fixed/shared.sqlite"],
] as const)("selects one database owner without changing %s store ownership", (layout, store) => {
  const root = tempDirs.make("configured-database-selection-");
  const env = { OPENCLAW_STATE_DIR: root };
  const cfg: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      entries: { first: {}, second: {} },
      defaults: { sessionStore: { agentId: "first" } },
    },
    acp: { allowedAgents: ["acp-only"] },
    ...(store ? { session: { store: path.join(root, store) } } : {}),
  };
  const ids = ["first", "second", "openclaw", "crestodian"];
  if (layout === "default") {
    ids.push("acp-only");
  }
  const expected = ids.map((agentId) => ({
    agentId,
    path: path.join(root, "agents", agentId, "agent", "openclaw-agent.sqlite"),
  }));
  const configured: Record<string, string> =
    layout === "shared"
      ? { first: "shared.sqlite" }
      : {
          first: "openclaw-agent.sqlite",
          second: "openclaw-agent.second.sqlite",
          "acp-only": "openclaw-agent.acp-only.sqlite",
        };
  if (layout !== "default") {
    expected.unshift(
      ...Object.entries(configured).map(([agentId, filename]) => ({
        agentId,
        path: path.join(root, layout === "template" ? agentId : "fixed", filename),
      })),
    );
  }
  const all = databaseTargets(cfg, { env, registeredDatabases: [] });
  expect(all).toHaveLength(expected.length);
  expect(all).toEqual(expect.arrayContaining(expected));
  for (const agentId of ["first", "second", "acp-only", "openclaw", "crestodian", "missing"]) {
    expect(databaseTargets(cfg, { env, registeredDatabases: [], agentId })).toEqual(
      expected.filter((target) => target.agentId === agentId),
    );
  }
});

it("resolves reserved startup targets without probing their files", () => {
  const root = tempDirs.make("system-database-targets-");
  const env = { OPENCLAW_STATE_DIR: root };
  const cfg = { agents: { entries: { main: {} } } };
  const dbPath = path.join(root, "agents", "openclaw", "agent", "openclaw-agent.sqlite");
  const options = { env, registeredDatabases: [], agentId: "openclaw" };
  using lstat = vi.spyOn(fs, "lstatSync");
  using stat = vi.spyOn(fs, "statSync");
  using realpath = vi.spyOn(fs.realpathSync, "native");

  expect(databaseCandidates(cfg, { env })).toContain(dbPath);
  expect(databaseTargets(cfg, options)).toEqual([{ agentId: "openclaw", path: dbPath }]);
  for (const probe of [lstat, stat, realpath]) {
    expect(probe.mock.calls.filter(([pathname]) => pathname === dbPath)).toEqual([]);
  }
});

it.each([
  ["agent", ""],
  ["store", ""],
  ["store", "   "],
] as const)("rejects blank --%s (%j) instead of defaulting", (option, value) => {
  expect(() => selectStores({}, { [option]: value })).toThrow(`--${option} must not be blank`);
});
