import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveInstallAgentDir } from "../agents/install-agent-dir.js";
import type { OpenClawConfigWithLegacyRoster } from "../config/legacy.roster.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { snapshotFiles } from "./state-migrations.caller-mode.test-helpers.js";
import { resolveLegacyProfileMigrationExceptions } from "./state-migrations.profile-scope.js";
import {
  createMigrationFixture,
  writeFixtureFile,
} from "./state-migrations.shard-fixture.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
    vi.restoreAllMocks();
  }),
);

async function makeFixture() {
  const root = tempDirs.make("openclaw-profile-workspace-");
  // Profile workspace ownership has no plugin-owned migration inputs.
  const bundledRoot = path.join(root, "extensions");
  fs.mkdirSync(bundledRoot);
  const fixture = createMigrationFixture(root, { bundledPluginsDir: bundledRoot });
  const { homeDir, configPath, env } = fixture;
  Object.assign(env, { OPENCLAW_HOME: homeDir, OPENCLAW_PROFILE: "work" });
  return {
    ...fixture,
    source: path.join(homeDir, ".openclaw", "workspace-work"),
    target: path.join(homeDir, ".openclaw-work", "workspace"),
    writeConfig: (cfg: OpenClawConfigWithLegacyRoster) =>
      fs.writeFileSync(configPath, JSON.stringify(cfg)),
    plan: async () => {
      const before = snapshotFiles(root);
      const plan = await fixture.plan();
      expect(snapshotFiles(root)).toEqual(before);
      return plan.steps.find((step) => step.id === "profile-workspace");
    },
  };
}

const marker = (directory: string) => fs.readFileSync(path.join(directory, "marker.txt"), "utf8");
function seedWorkspace(directory: string, content = directory) {
  writeFixtureFile(path.join(directory, "marker.txt"), content);
}

describe("configured profile workspace preservation", () => {
  it.each(["profile", "state-dir"])(
    "isolates Doctor/SDK reads in active %s except its workspace",
    async (selector) => {
      const fixture = await makeFixture();
      if (selector === "state-dir") {
        delete fixture.env.OPENCLAW_PROFILE;
      }
      delete fixture.env.OPENCLAW_AGENT_DIR;
      const defaultState = path.join(fixture.homeDir, ".openclaw");
      const ownWorkspace = path.join(defaultState, "workspace-work");
      for (const directory of ["agent", "workspace-work", "workspace-other"]) {
        seedWorkspace(path.join(defaultState, directory), directory);
      }
      const ownAgent = path.join(fixture.stateDir, "agent");
      writeFixtureFile(path.join(ownAgent, "settings.json"), "own SDK settings");
      const cfg: OpenClawConfig = {
        agents: { defaults: { systemAgent: { agentId: "work" } }, entries: { work: {} } },
        plugins: { enabled: false },
      };
      const params = { env: fixture.env, homedir: () => fixture.homeDir };
      const exceptions = resolveLegacyProfileMigrationExceptions(params);
      expect(exceptions).toEqual(selector === "profile" ? { profileWorkspace: ownWorkspace } : {});
      const reads = [
        vi.spyOn(fs, "existsSync"),
        vi.spyOn(fs, "statSync"),
        vi.spyOn(fs, "lstatSync"),
        vi.spyOn(fs, "realpathSync"),
        vi.spyOn(fs.realpathSync, "native"),
        vi.spyOn(fs, "readdirSync"),
        vi.spyOn(fs, "readFileSync"),
      ];
      const target = path.join(fixture.stateDir, "agents", "work", "agent");
      expect(resolveInstallAgentDir(cfg, params).directory.dir).toBe(target);
      const result = await fixture.migrate(cfg);
      const outsideReads = reads
        .flatMap((spy) => spy.mock.calls.map(([file]) => String(file)))
        .filter((file) => file === defaultState || file.startsWith(`${defaultState}${path.sep}`))
        .filter(
          (file) =>
            !Object.values(exceptions).some(
              (allowed) => file === allowed || file.startsWith(`${allowed}${path.sep}`),
            ),
        );
      expect(outsideReads).toEqual([]);
      for (const spy of reads) {
        spy.mockRestore();
      }
      expect(result.warnings).toEqual([]);
      expect(marker(path.join(defaultState, "agent"))).toBe("agent");
      expect(marker(path.join(defaultState, "workspace-other"))).toBe("workspace-other");
      expect(fs.readFileSync(path.join(target, "settings.json"), "utf8")).toBe("own SDK settings");
      const workspace =
        selector === "profile"
          ? path.join(fixture.homeDir, ".openclaw-work", "workspace")
          : ownWorkspace;
      expect(marker(workspace)).toBe("workspace-work");
    },
  );

  it.each([
    { roster: "defaults", endpoint: "source", alias: "none", targetExists: true },
    { roster: "entries", endpoint: "source", alias: "leaf", targetExists: true },
    { roster: "list", endpoint: "target", alias: "none", targetExists: true },
    { roster: "defaults", endpoint: "target", alias: "leaf", targetExists: true },
    { roster: "defaults", endpoint: "target", alias: "leaf", targetExists: false },
    { roster: "defaults", endpoint: "target", alias: "chain", targetExists: false },
    { roster: "defaults", endpoint: "target", alias: "ancestor", targetExists: false },
    { roster: "defaults", endpoint: "source", alias: "tilde", targetExists: false },
  ] as const)(
    "preserves $roster workspace: $endpoint/$alias/$targetExists",
    async ({ roster, endpoint, alias, targetExists }) => {
      const fixture = await makeFixture();
      const { source, target } = fixture;
      const directories = targetExists ? [source, target] : [source];
      for (const directory of directories) {
        seedWorkspace(directory);
      }
      const configured = endpoint === "source" ? source : target;
      const aliasPath = path.join(fixture.homeDir, "workspace-alias");
      const linkTarget = alias === "ancestor" ? path.dirname(target) : configured;
      const linked = alias !== "none" && alias !== "tilde";
      let workspace = alias === "tilde" ? "~/.openclaw/workspace-work" : configured;
      if (linked) {
        const linkType = process.platform === "win32" ? "junction" : "dir";
        fs.symlinkSync(linkTarget, aliasPath, linkType);
        workspace = alias === "ancestor" ? path.join(aliasPath, "workspace") : aliasPath;
        if (alias === "chain") {
          workspace = path.join(fixture.homeDir, "workspace-alias-chain");
          fs.symlinkSync(aliasPath, workspace, linkType);
        }
      }
      const agents: OpenClawConfigWithLegacyRoster["agents"] =
        roster === "defaults"
          ? { defaults: { workspace } }
          : roster === "entries"
            ? { entries: { main: { workspace } } }
            : { list: [{ id: "main", workspace }] };
      const cfg = { agents };
      fixture.writeConfig(cfg);
      const before = snapshotFiles(fixture.homeDir);
      const step = await fixture.plan();
      const skipped = { source: [], target: [], requiredness: "not-required" };
      expect(step).toMatchObject(skipped);
      expect(step?.refusal).toBeUndefined();
      const log = { info: vi.fn(), warn: vi.fn() };
      for (let run = 0; run < 2; run++) {
        const result = await fixture.migrate(cfg, { log });
        expect(result.stepReceipts.find((entry) => entry.id === "profile-workspace")).toMatchObject(
          { ...skipped, outcome: "skipped" },
        );
        expect(result.warnings).toEqual([]);
        if (targetExists) {
          const other = endpoint === "source" ? target : source;
          expect(result.notices).toContain(
            `Profile workspace: keeping configured workspace at ${configured}; existing workspace at ${other} was left unchanged.`,
          );
        }
        expect(snapshotFiles(fixture.homeDir)).toEqual(before);
        expect(fs.readFileSync(fixture.configPath, "utf8")).toBe(JSON.stringify(cfg));
      }
    },
  );

  it("uses native case semantics for absent targets", async () => {
    const fixture = await makeFixture();
    const { source, target } = fixture;
    seedWorkspace(source, "workspace marker");
    const caseInsensitive = fs.existsSync(
      path.join(fixture.homeDir, ".OPENCLAW", "WORKSPACE-WORK"),
    );
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { workspace: path.join(fixture.homeDir, ".OpenClaw-work", "workspace") },
      },
    };
    fixture.writeConfig(cfg);
    const step = await fixture.plan();
    expect(step).toMatchObject({
      source: caseInsensitive ? [] : [{ kind: "path", path: source }],
      target: caseInsensitive ? [] : [{ kind: "path", path: target }],
      requiredness: caseInsensitive ? "not-required" : "conditional",
    });
    const result = await fixture.migrate(cfg, { log: { info: vi.fn(), warn: vi.fn() } });
    expect(result.warnings).toEqual([]);
    expect(fs.existsSync(source)).toBe(caseInsensitive);
    expect(fs.existsSync(target)).toBe(!caseInsensitive);
    expect(marker(caseInsensitive ? source : target)).toBe("workspace marker");
    expect(fs.readFileSync(fixture.configPath, "utf8")).toBe(JSON.stringify(cfg));
  });
});
