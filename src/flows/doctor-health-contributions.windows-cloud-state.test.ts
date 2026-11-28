import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDoctorPrompter } from "../commands/doctor-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { initialDoctorHealthContribution } from "./doctor-health-contributions-selection.test-support.js";
import { runDoctorLintChecks } from "./doctor-lint-flow.js";
import { runDoctorHealthRepairs } from "./doctor-repair-flow.js";

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));

const tempDirs = createTempDirTracker();
const checkId = "core/doctor/state-integrity";
const warning = "Windows cloud-synced storage";
let home = "";
let cloudRoot = "";
let localRoot = "";

beforeEach(() => {
  home = tempDirs.make("openclaw-doctor-onedrive-");
  cloudRoot = path.join(home, "OneDrive");
  localRoot = path.join(home, "local");
  [cloudRoot, localRoot].forEach((directory) => fs.mkdirSync(directory));
  for (const name of ["HOME", "USERPROFILE", "OPENCLAW_HOME"]) {
    vi.stubEnv(name, home);
  }
  for (const name of ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]) {
    vi.stubEnv(name, undefined);
  }
});

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  await closeStateDatabaseForTest();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  tempDirs.cleanup();
});

function readPreservedFiles(files: string[], sqliteShmFiles: ReadonlySet<string>) {
  return files.map((file) => {
    if (!fs.existsSync(file)) {
      return [file, false];
    }
    const { mode, size } = fs.statSync(file);
    return [file, true, mode, size, sqliteShmFiles.has(file) ? undefined : fs.readFileSync(file)];
  });
}

it.skipIf(process.platform !== "win32").each([
  { placement: "consumer", warns: true, interactiveWarns: true },
  { placement: "business", warns: true, interactiveWarns: true },
  { placement: "local", warns: false, interactiveWarns: false },
  { placement: "prefix-neighbor", warns: false, interactiveWarns: false },
  { placement: "missing-leaf", warns: true, interactiveWarns: true },
  { placement: "junction-out", warns: false, interactiveWarns: false },
  { placement: "missing-junction-leaf", warns: false, interactiveWarns: false },
  { placement: "junction-in", warns: true, interactiveWarns: true },
  { placement: "selected-env-only", warns: true, interactiveWarns: false },
  { placement: "ambient-env-only", warns: false, interactiveWarns: true },
] as const)(
  "Doctor native Windows OneDrive flow: $placement preserves interactive, lint and dry-run behavior",
  async ({ placement, warns, interactiveWarns }) => {
    const localPaths: Partial<Record<typeof placement, string>> = {
      local: localRoot,
      "prefix-neighbor": `${cloudRoot}-local`,
    };
    let stateDir = localPaths[placement] ?? path.join(cloudRoot, "state");
    const storage = placement === "business" ? "OneDrive for Business" : "OneDrive";
    const missing = placement === "missing-leaf" || placement === "missing-junction-leaf";
    if (placement === "junction-out" || placement === "missing-junction-leaf") {
      const junction = path.join(cloudRoot, "local-link");
      fs.symlinkSync(localRoot, junction, "junction");
      stateDir = missing ? path.join(junction, "missing") : junction;
    } else if (placement === "junction-in") {
      stateDir = path.join(localRoot, "cloud-link");
      fs.symlinkSync(cloudRoot, stateDir, "junction");
    }
    if (!missing) {
      fs.mkdirSync(stateDir, { recursive: true });
    }
    const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    const configPath = path.join(home, "openclaw.json");
    fs.writeFileSync(configPath, `${JSON.stringify(cfg)}\n`);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const cloudVariable = placement === "business" ? "OneDriveCommercial" : "OneDrive";
    vi.stubEnv(cloudVariable, placement === "ambient-env-only" ? undefined : cloudRoot);
    const env = Object.freeze({ ...process.env });
    if (placement === "selected-env-only") {
      vi.stubEnv("OneDrive", undefined);
    } else if (placement === "ambient-env-only") {
      vi.stubEnv("OneDrive", cloudRoot);
    }
    const databases = missing
      ? []
      : [
          openOpenClawStateDatabase({ env }).path,
          openOpenClawAgentDatabase({ agentId: "main", env }).path,
        ];
    // Keep the seeded owners open on both sides; read-only opens can create sidecars.
    const preservedFiles = [
      configPath,
      ...databases.flatMap((database) =>
        ["", "-wal", "-shm", "-journal"].map((suffix) => `${database}${suffix}`),
      ),
    ];
    // SQLite SHM is mutable reader coordination, not DB content: sqlite.org/walformat.html.
    const sqliteShmFiles = new Set(databases.map((database) => `${database}-shm`));
    const before = readPreservedFiles(preservedFiles, sqliteShmFiles);
    const mode = missing ? undefined : fs.statSync(stateDir).mode;
    const contribution = initialDoctorHealthContribution("doctor:state-integrity");
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const options = { nonInteractive: true };
    const sharedContext = { cfg, configPath, env, runtime };
    await contribution.run({
      ...sharedContext,
      options,
      prompter: createDoctorPrompter({ runtime, options }),
      configResult: { cfg },
      cfgForPersistence: cfg,
      sourceConfigValid: true,
    });
    const text = vi
      .mocked(note)
      .mock.calls.filter((call) => call[1] === "State integrity")
      .map((call) => String(call[0]))
      .join("\n");
    expect(text.includes(warning)).toBe(interactiveWarns);
    if (interactiveWarns) {
      expect(text).toContain(storage);
      expect(text).toContain("stop the Gateway");
      expect(text).toContain("for the Gateway service (not just");
    }

    expect(contribution.updateWork?.kind).not.toBe("standalone");
    const checks = contribution.healthChecks;
    expect(checks).toEqual([expect.objectContaining({ id: checkId, defaultEnabled: false })]);
    const ctx = { ...sharedContext, mode: "lint" as const };
    await expect(runDoctorLintChecks(ctx, { checks })).resolves.toMatchObject({
      checksRun: 0,
      checksSkipped: 1,
    });
    const lint = await runDoctorLintChecks(ctx, { checks, onlyIds: [checkId] });
    expect(lint).toMatchObject({ checksRun: 1, checksSkipped: 0 });
    const cloudFindings = lint.findings.filter((finding) => finding.message.includes(warning));
    expect(cloudFindings).toHaveLength(warns ? 1 : 0);
    if (warns) {
      expect(cloudFindings[0]).toMatchObject({
        checkId,
        severity: "warning",
        path: missing ? stateDir : fs.realpathSync(stateDir),
        fixHint:
          "Move OPENCLAW_STATE_DIR to local non-synced storage such as %USERPROFILE%\\.openclaw.",
      });
    }
    const repair = await runDoctorHealthRepairs(
      { ...ctx, mode: "fix", dryRun: true },
      { checks, dryRun: true },
    );
    expect(repair).toMatchObject({ warnings: [], changes: [] });
    expect(repair.config).toEqual(cfg);
    const action = "would-recommend-moving-state-dir";
    const effect = {
      kind: "state",
      action,
      target: missing ? stateDir : fs.realpathSync(stateDir),
      dryRunSafe: true,
    };
    expect(repair.effects.filter((entry) => entry.action === action)).toEqual(
      warns ? [effect] : [],
    );
    assert.deepStrictEqual(
      readPreservedFiles(preservedFiles, sqliteShmFiles),
      before,
      `${placement}: files, modes, sizes and bytes preserved`,
    );
    expect(cfg).toEqual({ agents: { entries: { main: {} } } });
    expect(env[cloudVariable]).toBe(placement === "ambient-env-only" ? undefined : cloudRoot);
    expect(fs.existsSync(stateDir) && fs.statSync(stateDir).mode).toBe(missing ? false : mode);
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  },
);
