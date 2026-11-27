import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { readPersistedInstalledPluginIndexInstallRecordsAsync } from "../../plugins/installed-plugin-index-record-reader.js";
import { writeManagedNpmPlugin } from "../../plugins/test-helpers/managed-npm-plugin.js";
import {
  CommandProcessCleanupError,
  recordCommandProcessFailure,
} from "../../process/exec-result.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import { createCommandResult as processResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import {
  collectPostCorePluginAdvisories,
  createPostCorePluginUpdateResult,
} from "./update-command-plugins-internals.js";
import { applyPostPluginUpdateReadiness } from "./update-command-post-plugin-readiness.js";

vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  runUtf8CommandWithTimeout: vi.fn(),
}));
// The CLI unit shard uses worker threads without the shared-state host broker.
// Exercise the final payload check against a controlled committed-record receipt.
vi.mock("../../plugins/installed-plugin-index-record-reader.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../plugins/installed-plugin-index-record-reader.js")
  >()),
  readPersistedInstalledPluginIndexInstallRecordsAsync: vi.fn(),
}));

afterEach(() => vi.resetAllMocks());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const execute = vi.mocked(runUtf8CommandWithTimeout);
const repair = "Run `openclaw update repair` to retry post-update readiness checks.";

async function inspect(
  outcome: Error | Parameters<typeof processResult>[0],
  status: "ok" | "error" = "ok",
) {
  execute.mockImplementation(() =>
    outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(processResult(outcome)),
  );
  return applyPostPluginUpdateReadiness({
    root: "/synthetic/openclaw",
    entryPath: "/synthetic/openclaw/dist/index.js",
    nodeRunner: process.execPath,
    timeoutMs: 5_000,
    pluginUpdate: createPostCorePluginUpdateResult({ status }),
  });
}

it("redacts caught execution errors before publishing repair warnings", async () => {
  const result = await inspect(new Error("https://example.test/?token=fixture-secret"));
  expect(result).toMatchObject({
    status: "warning",
    doctorLint: { command: "doctor --lint --json --severity-min error" },
    warnings: [{ message: expect.stringContaining("token=<redacted>") }],
  });
  expect(JSON.stringify(result)).not.toContain("fixture-secret");
});

it("defers contention without masking an existing plugin error", async () => {
  const result = await inspect(
    { code: 1, cleanup: "normal", stderr: "database is locked" },
    "error",
  );
  expect(result).toMatchObject({
    status: "error",
    doctorLint: { advisory: { kind: "recoverable-maintenance" } },
    warnings: [
      {
        reason: "doctor-advisory",
        message: expect.stringContaining("database is locked"),
        guidance: [repair],
      },
    ],
  });
  expect(result.failureFacts).toBeUndefined();
});

it.each([
  new CommandProcessCleanupError(),
  recordCommandProcessFailure(new Error("Inspection output failed"), {
    code: 1,
    cleanup: "uncertain",
    termination: "exit",
  }),
  processResult({ cleanup: "uncertain" }),
])("preserves uncertain cleanup without deferring active work (case %#)", async (outcome) => {
  await expect(inspect(outcome)).rejects.toBeInstanceOf(CommandProcessCleanupError);
});

it("keeps budget-deferred inspection receipts advisory when no check ran", async () => {
  const finding = {
    checkId: "core/doctor/lint-inspection",
    severity: "warning",
    errorCode: "update-inspection-deferred",
    message: "Inspection allowance exhausted.",
    fixHint: "Run `openclaw doctor --fix` after activation.",
  };
  expect(
    await inspect({
      cleanup: "normal",
      stdout: JSON.stringify({ ok: true, checksRun: 0, findings: [], warnings: [finding] }),
    }),
  ).toMatchObject({
    status: "warning",
    doctorLint: {
      exitCode: 0,
      doctorLintFindings: [finding],
      advisory: { kind: "recoverable-maintenance" },
    },
    warnings: expect.arrayContaining([
      expect.objectContaining({
        errorCode: "update-inspection-deferred",
        guidance: [finding.fixHint],
      }),
      expect.objectContaining({ guidance: [repair] }),
    ]),
  });
});

it("reports final version mismatches once, not ones a later Doctor repaired", async () => {
  const root = tempDirs.make("post-plugin-version-repair-");
  const stateDir = path.join(root, "state");
  const targetVersion = "2026.11.10";
  const oldVersion = "2026.10.10";
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: targetVersion }));
  const records: Record<string, PluginInstallRecord> = {};
  for (const [pluginId, packageName, version] of [
    ["codex", "@openclaw/codex", targetVersion],
    ["groq", "@openclaw/groq-provider", oldVersion],
    ["tokenjuice", "@openclaw/tokenjuice", oldVersion],
  ] as const) {
    records[pluginId] = {
      source: "npm",
      spec: packageName,
      resolvedName: packageName,
      resolvedVersion: pluginId === "tokenjuice" ? targetVersion : version,
      installPath: writeManagedNpmPlugin({ stateDir, packageName, pluginId, version }),
    };
  }
  vi.mocked(readPersistedInstalledPluginIndexInstallRecordsAsync).mockResolvedValue(records);
  const mismatches = Object.keys(records).map((pluginId) => ({
    pluginId,
    reason: "plugin-version-mismatch",
    message: `Plugin "${pluginId}" could not be updated.`,
    guidance: [],
  }));
  const unavailable = {
    pluginId: "groq",
    reason: "plugin-target-unavailable",
    message: "Groq target remains unavailable.",
    guidance: [],
  };
  const migration = {
    pluginId: "codex",
    reason: "doctor-advisory",
    message: "Codex data migration remains pending.",
    guidance: [],
  };
  execute.mockResolvedValue(
    processResult({
      cleanup: "normal",
      stdout: JSON.stringify({ ok: true, checksRun: 1, findings: [], warnings: [] }),
    }),
  );
  const result = await applyPostPluginUpdateReadiness({
    root,
    entryPath: path.join(root, "dist", "index.js"),
    timeoutMs: 5_000,
    pluginUpdate: createPostCorePluginUpdateResult({
      status: "warning",
      changed: true,
      npm: {
        changed: true,
        outcomes: mismatches.map(({ pluginId, message }) => ({
          pluginId,
          message,
          status: "error",
        })),
      },
      warnings: [...mismatches, unavailable, migration],
    }),
  });
  expect(result.warnings).toEqual([
    ...mismatches.filter(({ pluginId }) => pluginId !== "codex"),
    unavailable,
    migration,
  ]);
  expect(result.npm.outcomes.at(-1)).toMatchObject({
    pluginId: "codex",
    status: "updated",
    nextVersion: targetVersion,
  });
  expect(collectPostCorePluginAdvisories(result)).toEqual([
    unavailable.message,
    migration.message,
    'Plugin "tokenjuice" could not be updated.',
  ]);
  const finalDoctorDrift =
    "core/doctor/workspace-status: Plugin tokenjuice is 2026.10.10, but a Gateway restart will load OpenClaw 2026.11.10.";
  expect(collectPostCorePluginAdvisories(result, [finalDoctorDrift])).toEqual([
    unavailable.message,
    migration.message,
  ]);
});
