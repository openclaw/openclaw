import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import {
  createCallerModeSnapshot,
  snapshotFiles,
} from "./state-migrations.caller-mode.test-helpers.js";
import {
  autoMigrateLegacyState,
  planLegacyStateMigrationsReadOnly,
} from "./state-migrations.doctor.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
    vi.restoreAllMocks();
  }),
);

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function candidateAt(root: string) {
  return { root, version: "test" };
}

async function makeFixture() {
  const root = tempDirs.make("openclaw-profile-workspace-");
  const homeDir = path.join(root, "home");
  const stateDir = path.join(root, "copied-state");
  const configPath = path.join(root, "copied-openclaw.json");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.symlinkSync(
    path.resolve("extensions"),
    path.join(root, "extensions"),
    process.platform === "win32" ? "junction" : "dir",
  );
  fs.writeFileSync(configPath, "{}\n");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    OPENCLAW_HOME: homeDir,
    OPENCLAW_PROFILE: "work",
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
  };
  return { root, homeDir, stateDir, configPath, env };
}

describe("configured profile workspace preservation", () => {
  it.each([
    ["defaults", "source", false],
    ["defaults", "source", true],
    ["entries", "source", false],
    ["entries", "source", true],
    ["list", "source", false],
    ["list", "source", true],
    ["defaults", "target", false],
    ["defaults", "target", true],
    ["entries", "target", false],
    ["entries", "target", true],
    ["list", "target", false],
    ["list", "target", true],
  ] as const)(
    "excludes configured %s %s workspace (alias=%s) from planning authority",
    async (roster, endpoint, alias) => {
      const fixture = await makeFixture();
      fixture.env.OPENCLAW_PROFILE = "work";
      const source = path.join(fixture.homeDir, ".openclaw", "workspace-work");
      const target = path.join(fixture.homeDir, ".openclaw-work", "workspace");
      for (const directory of [source, target]) {
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, "marker.txt"), directory);
      }
      const configured = endpoint === "source" ? source : target;
      const workspace = alias ? path.join(fixture.homeDir, "workspace-alias") : configured;
      if (alias) {
        fs.symlinkSync(configured, workspace, process.platform === "win32" ? "junction" : "dir");
      }
      const agents: OpenClawConfig["agents"] =
        roster === "defaults"
          ? { defaults: { workspace } }
          : roster === "entries"
            ? { entries: { main: { workspace } } }
            : { list: [{ id: "main", workspace }] };
      fs.writeFileSync(fixture.configPath, JSON.stringify({ agents }));
      const before = snapshotFiles(fixture.root);
      const plan = await planLegacyStateMigrationsReadOnly({
        mode: "doctor",
        candidate: candidateAt(fixture.root),
        snapshot: createCallerModeSnapshot(fixture),
        env: fixture.env,
      });
      const step = plan.steps.find((entry) => entry.id === "profile-workspace");
      expect(step).toMatchObject({ source: [], target: [], requiredness: "not-required" });
      expect(step?.refusal).toBeUndefined();
      expect(snapshotFiles(fixture.root)).toEqual(before);
      const log = { info: vi.fn(), warn: vi.fn() };
      for (let run = 0; run < 2; run++) {
        const result = await autoMigrateLegacyState({
          cfg: { agents },
          log,
          doctorOnlyStateMigrations: true,
          env: fixture.env,
          homedir: () => fixture.homeDir,
          legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
        });
        expect(result.stepReceipts.find((entry) => entry.id === "profile-workspace")).toMatchObject(
          {
            source: [],
            target: [],
            requiredness: "not-required",
            outcome: "skipped",
          },
        );
        expect(result.warnings).toEqual([]);
        expect(log.info).toHaveBeenCalledWith(expect.stringContaining("was left unchanged"));
        expect(result.notices).toContain(
          `Profile workspace: keeping configured workspace at ${configured}; existing workspace at ${endpoint === "source" ? target : source} was left unchanged.`,
        );
        for (const directory of [source, target]) {
          expect(snapshotFiles(directory)).toEqual({
            ".": "directory",
            "marker.txt": sha256(directory).replace("sha256:", "file:sha256:"),
          });
        }
        expect(fs.readFileSync(fixture.configPath, "utf8")).toBe(JSON.stringify({ agents }));
        if (alias) {
          expect(fs.readlinkSync(workspace)).toBe(configured);
        }
      }
    },
  );

  it.each(["leaf", "chain", "ancestor"] as const)(
    "preserves an absent configured target through a dangling %s alias",
    async (kind) => {
      const fixture = await makeFixture();
      fixture.env.OPENCLAW_PROFILE = "work";
      const source = path.join(fixture.homeDir, ".openclaw", "workspace-work");
      const target = path.join(fixture.homeDir, ".openclaw-work", "workspace");
      fs.mkdirSync(source, { recursive: true });
      fs.writeFileSync(path.join(source, "marker.txt"), "configured target must stay absent");
      const alias = path.join(fixture.homeDir, "workspace-alias");
      const linkTarget = kind === "ancestor" ? path.dirname(target) : target;
      const linkType = process.platform === "win32" ? "junction" : "dir";
      fs.symlinkSync(linkTarget, alias, linkType);
      let workspace = kind === "ancestor" ? path.join(alias, "workspace") : alias;
      if (kind === "chain") {
        workspace = path.join(fixture.homeDir, "workspace-alias-chain");
        fs.symlinkSync(alias, workspace, linkType);
      }
      const cfg: OpenClawConfig = { agents: { defaults: { workspace } } };
      fs.writeFileSync(fixture.configPath, JSON.stringify(cfg));
      const before = snapshotFiles(fixture.root);
      const plan = await planLegacyStateMigrationsReadOnly({
        mode: "doctor",
        candidate: candidateAt(fixture.root),
        snapshot: createCallerModeSnapshot(fixture),
        env: fixture.env,
      });
      expect(plan.steps.find((step) => step.id === "profile-workspace")).toMatchObject({
        source: [],
        target: [],
        requiredness: "not-required",
      });
      expect(snapshotFiles(fixture.root)).toEqual(before);
      for (let run = 0; run < 2; run++) {
        const result = await autoMigrateLegacyState({
          cfg,
          log: { info: vi.fn(), warn: vi.fn() },
          doctorOnlyStateMigrations: true,
          env: fixture.env,
          homedir: () => fixture.homeDir,
          legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
        });
        expect(result.warnings).toEqual([]);
        expect(result.stepReceipts.find((step) => step.id === "profile-workspace")).toMatchObject({
          source: [],
          target: [],
          requiredness: "not-required",
          outcome: "skipped",
        });
        expect(fs.readFileSync(path.join(source, "marker.txt"), "utf8")).toBe(
          "configured target must stay absent",
        );
        expect(fs.existsSync(target)).toBe(false);
        expect(fs.readlinkSync(alias)).toBe(linkTarget);
        expect(fs.readFileSync(fixture.configPath, "utf8")).toBe(JSON.stringify(cfg));
      }
    },
  );

  it("honors native case semantics for an absent configured target", async () => {
    const fixture = await makeFixture();
    fixture.env.OPENCLAW_PROFILE = "work";
    const source = path.join(fixture.homeDir, ".openclaw", "workspace-work");
    const target = path.join(fixture.homeDir, ".openclaw-work", "workspace");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "marker.txt"), "workspace marker");
    const caseInsensitive = fs.existsSync(
      path.join(fixture.homeDir, ".OPENCLAW", "WORKSPACE-WORK"),
    );
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { workspace: path.join(fixture.homeDir, ".OpenClaw-work", "workspace") },
      },
    };
    fs.writeFileSync(fixture.configPath, JSON.stringify(cfg));
    const before = snapshotFiles(fixture.root);
    const plan = await planLegacyStateMigrationsReadOnly({
      mode: "doctor",
      candidate: candidateAt(fixture.root),
      snapshot: createCallerModeSnapshot(fixture),
      env: fixture.env,
    });
    expect(plan.steps.find((step) => step.id === "profile-workspace")).toMatchObject({
      source: caseInsensitive ? [] : [{ kind: "path", path: source }],
      target: caseInsensitive ? [] : [{ kind: "path", path: target }],
      requiredness: caseInsensitive ? "not-required" : "conditional",
    });
    expect(snapshotFiles(fixture.root)).toEqual(before);
    const result = await autoMigrateLegacyState({
      cfg,
      log: { info: vi.fn(), warn: vi.fn() },
      doctorOnlyStateMigrations: true,
      env: fixture.env,
      homedir: () => fixture.homeDir,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });
    expect(result.warnings).toEqual([]);
    expect(fs.existsSync(source)).toBe(caseInsensitive);
    expect(fs.existsSync(target)).toBe(!caseInsensitive);
    expect(
      fs.readFileSync(path.join(caseInsensitive ? source : target, "marker.txt"), "utf8"),
    ).toBe("workspace marker");
    expect(fs.readFileSync(fixture.configPath, "utf8")).toBe(JSON.stringify(cfg));
  });

  it("keeps an explicitly configured source when the target is absent", async () => {
    const fixture = await makeFixture();
    const source = path.join(fixture.homeDir, ".openclaw", "workspace-work");
    const target = path.join(fixture.homeDir, ".openclaw-work", "workspace");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "marker.txt"), "configured source");
    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: "~/.openclaw/workspace-work" } },
    };
    fs.writeFileSync(fixture.configPath, JSON.stringify(cfg));
    const result = await autoMigrateLegacyState({
      cfg,
      log: { info: vi.fn(), warn: vi.fn() },
      doctorOnlyStateMigrations: true,
      env: fixture.env,
      homedir: () => fixture.homeDir,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });
    expect(result.warnings).toEqual([]);
    expect(result.stepReceipts.find((step) => step.id === "profile-workspace")).toMatchObject({
      source: [],
      target: [],
      requiredness: "not-required",
      outcome: "skipped",
    });
    expect(fs.readFileSync(path.join(source, "marker.txt"), "utf8")).toBe("configured source");
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readFileSync(fixture.configPath, "utf8")).toBe(JSON.stringify(cfg));
  });
});
