import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfigWithLegacyRoster } from "../config/legacy.roster.js";
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
  // Profile workspace ownership has no plugin-owned migration inputs.
  const bundledRoot = path.join(root, "extensions");
  fs.mkdirSync(bundledRoot);
  fs.writeFileSync(configPath, "{}\n");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    OPENCLAW_HOME: homeDir,
    OPENCLAW_PROFILE: "work",
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
  };
  return { root, homeDir, stateDir, configPath, env };
}

describe("configured profile workspace preservation", () => {
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
    "preserves configured $roster $endpoint workspace (alias=$alias, targetExists=$targetExists)",
    async ({ roster, endpoint, alias, targetExists }) => {
      const fixture = await makeFixture();
      const source = path.join(fixture.homeDir, ".openclaw", "workspace-work");
      const target = path.join(fixture.homeDir, ".openclaw-work", "workspace");
      const directories = targetExists ? [source, target] : [source];
      for (const directory of directories) {
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, "marker.txt"), directory);
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
      fs.writeFileSync(fixture.configPath, JSON.stringify(cfg));
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
          cfg,
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
        if (targetExists) {
          expect(log.info).toHaveBeenCalledWith(expect.stringContaining("was left unchanged"));
          expect(result.notices).toContain(
            "Profile workspace: keeping configured workspace at " +
              configured +
              "; existing workspace at " +
              (endpoint === "source" ? target : source) +
              " was left unchanged.",
          );
        } else {
          expect(fs.existsSync(target)).toBe(false);
        }
        for (const directory of directories) {
          expect(snapshotFiles(directory)).toEqual({
            ".": "directory",
            "marker.txt": sha256(directory).replace("sha256:", "file:sha256:"),
          });
        }
        expect(fs.readFileSync(fixture.configPath, "utf8")).toBe(JSON.stringify(cfg));
        if (linked) {
          expect(fs.readlinkSync(aliasPath)).toBe(linkTarget);
        }
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
});
