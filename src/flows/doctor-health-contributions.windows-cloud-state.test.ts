import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDoctorPrompter } from "../commands/doctor-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveInitialDoctorHealthContributions } from "./doctor-health-contributions-initial.js";
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
  fs.mkdirSync(cloudRoot);
  fs.mkdirSync(localRoot);
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("OPENCLAW_HOME", home);
  vi.stubEnv("OPENCLAW_STATE_DIR", localRoot);
  vi.stubEnv("OneDrive", undefined);
  vi.stubEnv("OneDriveConsumer", undefined);
  vi.stubEnv("OneDriveCommercial", undefined);
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  tempDirs.cleanup();
});

function readPreservedFiles(files: string[], sqliteShmFiles: ReadonlySet<string>) {
  return files.map((file) => {
    if (!fs.existsSync(file)) {
      return { file, exists: false };
    }
    const stat = fs.statSync(file);
    return {
      file,
      exists: true,
      bytes: sqliteShmFiles.has(file) ? undefined : fs.readFileSync(file),
      mode: stat.mode,
      size: stat.size,
    };
  });
}

describe.skipIf(process.platform !== "win32")("Doctor native Windows OneDrive flow", () => {
  it.each([
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
    "$placement preserves interactive, lint and dry-run behavior",
    async ({ placement, warns, interactiveWarns }) => {
      let stateDir = path.join(cloudRoot, "state");
      let storage = "OneDrive";
      let missing = false;
      switch (placement) {
        case "consumer":
        case "selected-env-only":
        case "ambient-env-only":
          break;
        case "business":
          storage = "OneDrive for Business";
          break;
        case "local":
          stateDir = localRoot;
          break;
        case "prefix-neighbor":
          stateDir = `${cloudRoot}-local`;
          break;
        case "missing-leaf":
          missing = true;
          break;
        case "junction-out":
        case "missing-junction-leaf": {
          const junction = path.join(cloudRoot, "local-link");
          fs.symlinkSync(localRoot, junction, "junction");
          stateDir = placement === "junction-out" ? junction : path.join(junction, "missing");
          missing = placement === "missing-junction-leaf";
          break;
        }
        case "junction-in": {
          stateDir = path.join(localRoot, "cloud-link");
          fs.symlinkSync(cloudRoot, stateDir, "junction");
          break;
        }
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
      const databases: string[] = [];
      if (!missing) {
        databases.push(openOpenClawStateDatabase({ env }).path);
        databases.push(openOpenClawAgentDatabase({ agentId: "main", env }).path);
      }
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
      const unrelatedRunner = vi.fn(async () => {
        throw new Error("An unrelated Doctor contribution ran");
      });
      const contribution = resolveInitialDoctorHealthContributions({
        runStructuredHealthRepairs: unrelatedRunner,
        runGatewayConfigHealth: unrelatedRunner,
        runAuthProfileMigration: unrelatedRunner,
        runAuthProfileHealth: unrelatedRunner,
        runGatewayAuthHealth: unrelatedRunner,
        runLegacyStateHealth: unrelatedRunner,
      }).find((entry) => entry.id === "doctor:state-integrity");
      if (!contribution) {
        throw new Error("Missing state-integrity contribution");
      }
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const options = { nonInteractive: true };
      await contribution.run({
        runtime,
        options,
        prompter: createDoctorPrompter({ runtime, options }),
        configResult: { cfg },
        cfg,
        cfgForPersistence: cfg,
        sourceConfigValid: true,
        configPath,
        env,
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
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({ id: checkId, defaultEnabled: false });
      const ctx = { mode: "lint" as const, cfg, configPath, env, runtime };
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
      expect(repair.warnings).toEqual([]);
      expect(repair.changes).toEqual([]);
      expect(repair.config).toEqual(cfg);
      expect(
        repair.effects.filter((effect) => effect.action === "would-recommend-moving-state-dir"),
      ).toEqual(
        warns
          ? [
              {
                kind: "state",
                action: "would-recommend-moving-state-dir",
                target: missing ? stateDir : fs.realpathSync(stateDir),
                dryRunSafe: true,
              },
            ]
          : [],
      );
      const after = readPreservedFiles(preservedFiles, sqliteShmFiles);
      assert.equal(after.length, before.length, `${placement}: snapshot file count`);
      for (const [index, expected] of before.entries()) {
        const label = `${placement}: ${path.relative(home, expected.file)}`;
        const actual = after[index];
        assert.ok(actual, `${label}: missing snapshot`);
        assert.equal(actual.file === expected.file, true, `${label}: file`);
        assert.equal(actual.exists, expected.exists, `${label}: exists`);
        assert.equal(actual.mode, expected.mode, `${label}: mode`);
        assert.equal(actual.size, expected.size, `${label}: size`);
        assert.equal(
          actual.bytes === undefined,
          expected.bytes === undefined,
          `${label}: bytes present`,
        );
        if (actual.bytes !== undefined && expected.bytes !== undefined) {
          if (!actual.bytes.equals(expected.bytes)) {
            let offset = 0;
            const limit = Math.min(actual.bytes.length, expected.bytes.length);
            while (offset < limit && actual.bytes[offset] === expected.bytes[offset]) {
              offset += 1;
            }
            assert.fail(
              `${label}: bytes ${JSON.stringify({
                expectedLength: expected.bytes.length,
                actualLength: actual.bytes.length,
                expectedSha256: createHash("sha256").update(expected.bytes).digest("hex"),
                actualSha256: createHash("sha256").update(actual.bytes).digest("hex"),
                firstDifferentOffset: offset,
              })}`,
            );
          }
        }
      }
      expect(cfg).toEqual({ agents: { entries: { main: {} } } });
      expect(env[cloudVariable]).toBe(placement === "ambient-env-only" ? undefined : cloudRoot);
      expect(fs.existsSync(stateDir)).toBe(!missing);
      if (!missing) {
        expect(fs.statSync(stateDir).mode).toBe(mode);
      }
      expect(unrelatedRunner).not.toHaveBeenCalled();
      expect(runtime.error).not.toHaveBeenCalled();
      expect(runtime.exit).not.toHaveBeenCalled();
    },
  );
});
