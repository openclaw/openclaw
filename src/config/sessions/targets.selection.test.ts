import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { selectAgentDatabaseInspectionTargets } from "../../state/openclaw-database-preflight-targets.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  isConfiguredAgentDatabaseTarget,
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

it("matches configured database targets linearly without redundant filesystem probes", () => {
  const root = fs.realpathSync.native(tempDirs.make("database-target-matching-"));
  const env = { OPENCLAW_STATE_DIR: root };
  const entries: Record<string, Record<string, never>> = {};
  const configuredTargets: Array<{ agentId: string; path: string }> = [];
  for (let i = 0; i < 20; i++) {
    const agentId = `agent-${i}`;
    entries[agentId] = {};
    const dbPath = path.join(root, "agents", agentId, "agent", "openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, "");
    configuredTargets.push({ agentId, path: dbPath });
  }
  const unregisteredPath = path.join(root, "unregistered.sqlite");
  fs.writeFileSync(unregisteredPath, "");
  const aliasDir = path.join(root, "alias");
  fs.symlinkSync(path.join(root, "agents", "agent-19", "agent"), aliasDir);
  const aliasPath = path.join(aliasDir, "openclaw-agent.sqlite");
  const cfg: OpenClawConfig = { agents: { ownership: "explicit", entries } };
  const candidatePaths = databaseCandidates(cfg, { env });

  using stat = vi.spyOn(fs, "statSync");
  using realpath = vi.spyOn(fs.realpathSync, "native");
  const last = configuredTargets.at(-1)!;
  expect(
    isConfiguredAgentDatabaseTarget(
      [...configuredTargets, ...candidatePaths.map((pathname) => ({ path: pathname }))],
      undefined,
      last.path,
    ),
  ).toBe(true);
  expect(stat).not.toHaveBeenCalled();
  expect(realpath).not.toHaveBeenCalled();

  expect(isConfiguredAgentDatabaseTarget(configuredTargets, "agent-19", aliasPath)).toBe(true);
  expect(isConfiguredAgentDatabaseTarget(configuredTargets, "agent-0", aliasPath)).toBe(false);
  expect(
    isConfiguredAgentDatabaseTarget(
      configuredTargets,
      undefined,
      path.join(root, "missing.sqlite"),
    ),
  ).toBe(false);
  stat.mockClear();
  realpath.mockClear();

  const selected = selectAgentDatabaseInspectionTargets(
    {
      env,
      purpose: "runtime",
      agentAdmissionConfig: cfg,
      configuredAgentDatabaseCandidatePaths: candidatePaths,
    },
    [
      ...configuredTargets.map(({ path: pathname }) => ({ path: pathname })),
      { agentId: "agent-19", path: aliasPath },
      { path: unregisteredPath },
    ],
    configuredTargets,
  );
  expect(selected.inspectionTargets.map((row) => row.path)).toEqual([
    ...configuredTargets.map((target) => target.path),
    aliasPath,
  ]);
  expect(stat.mock.calls.length).toBeLessThanOrEqual(configuredTargets.length * 3 + 10);
  expect(realpath.mock.calls.length).toBeLessThanOrEqual(configuredTargets.length + 5);
});
