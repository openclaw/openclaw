import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as container from "../../infra/container-environment.js";
import * as packageMetadata from "../../infra/update-check-package-target.js";
import * as updateCheck from "../../infra/update-check.js";
import { prepareUpdateFailureReport } from "../../infra/update-failure-report-prepare.js";
import { listUpdateRuns } from "../../infra/update-run-ledger.js";
import {
  renderUpdateRunReport,
  updateRunReportInputFromResult,
} from "../../infra/update-run-report.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import * as windowsUser from "../../infra/windows-user-sid.js";
import * as processRunner from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { isReportableUpdateRun } from "../../shared/update-outcome-classification.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { createCommandResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import * as shared from "./shared.js";
import * as finalization from "./update-command-finalize.js";
import * as servicePlan from "./update-command-service-plan.js";
import { updateCommand } from "./update-command.js";
import { updateRepairCommand } from "./update-repair-command.js";

const triage = vi.hoisted(() => vi.fn());
vi.mock("../../infra/update-triage.js", () => ({
  prepareUpdateFailureTriage: async () => triage,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
const windowsUserSid = "S-1-5-21-100";
let root: string;
let output: unknown[];
let lines: string[];

beforeEach(async () => {
  vi.spyOn(windowsUser, "readWindowsUserSid").mockReturnValue(windowsUserSid);
  const base = dirs.make("update-install-layout-");
  root = path.join(base, "app");
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), '{"name":"openclaw","version":"2026.9.4"}');
  vi.stubEnv("HOME", base);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(base, "state"));
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(base, "state", "openclaw.json"));
  vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(root);
  vi.spyOn(process, "cwd").mockReturnValue(root);
  vi.spyOn(processRunner, "runCommandWithTimeout").mockImplementation(async (argv) => {
    if (
      argv[0] !== "git" &&
      argv.join(" ") !== "npm root -g" &&
      argv.join(" ") !== "pnpm root -g"
    ) {
      throw new Error(`Unexpected command for untouched installation: ${argv.join(" ")}`);
    }
    return createCommandResult({
      stderr: "not a global install or Git checkout",
      code: 1,
    });
  });
  output = [];
  lines = [];
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation((value) => {
    output.push(value);
  });
  vi.spyOn(defaultRuntime, "log").mockImplementation((value) => {
    lines.push(String(value));
  });
  vi.spyOn(defaultRuntime, "error").mockImplementation((value) => {
    lines.push(String(value));
  });
  triage.mockClear();
});

afterEach(async () => {
  await closeStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const expectNoDatabase = () =>
  expect(fs.stat(resolveOpenClawStateSqlitePath(process.env))).rejects.toMatchObject({
    code: "ENOENT",
  });

it.each([
  { kind: "container", database: true, terminal: false },
  { kind: "container", database: false, terminal: true },
  { kind: "unmanaged", database: true, terminal: false },
  ...(process.platform === "win32"
    ? []
    : [
        { kind: "brew", database: false, terminal: true },
        { kind: "brew", database: true, terminal: true },
      ]),
])(
  "reports $kind non-outcomes without changing the installation (history: $database)",
  async ({ kind, database, terminal }) => {
    const reason = kind === "container" ? "container-image-install" : "unmanaged-package-install";
    const action =
      kind === "container"
        ? "Pull or build"
        : kind === "brew"
          ? "brew upgrade openclaw-cli"
          : "Reinstall";
    if (database) {
      openOpenClawStateDatabase();
    }
    vi.spyOn(container, "isContainerEnvironment").mockReturnValue(kind === "container");
    if (kind === "brew") {
      const prefix = dirs.make("brew-cellar-");
      vi.stubEnv("HOMEBREW_PREFIX", prefix);
      root = path.join(prefix, "Cellar/openclaw-cli/2026.9.4/libexec/lib/node_modules/openclaw");
      await fs.mkdir(path.join(root, "dist"), { recursive: true });
      await fs.writeFile(
        path.join(root, "package.json"),
        '{"name":"openclaw","version":"2026.9.4"}',
      );
      vi.mocked(shared.resolveUpdateRoot).mockResolvedValue(root);
      vi.mocked(process.cwd).mockReturnValue(root);
    }
    await expect(updateCommand({ json: true, yes: true, channel: "stable" })).rejects.toMatchObject(
      { code: 0 },
    );
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({
      status: "skipped",
      reason,
      before: { version: "2026.9.4" },
    });
    if (kind === "brew") {
      expect(output[0]).toHaveProperty("steps", []);
    } else {
      expect(output[0]).toHaveProperty("steps.0.failureFacts.0.code", "installation-unclassified");
    }
    expect(output[0]).not.toHaveProperty("recovery");
    if (database) {
      const run = listUpdateRuns({ limit: 1 })[0]!;
      expect(run).toMatchObject({
        status: "skipped",
        reason,
        origin: { nextAction: expect.stringContaining(action) },
      });
      expect(renderUpdateRunReport(run).markdown).toContain(action);
      expect(isReportableUpdateRun(run)).toBe(false);
      expect(output[0]).toMatchObject({
        runId: run.runId,
        run: { origin: { nextAction: expect.stringContaining(action) } },
      });
    } else {
      expect(output[0]).not.toHaveProperty("runId");
      const result = output[0] as UpdateRunResult;
      expect(renderUpdateRunReport(updateRunReportInputFromResult(result)).markdown).toContain(
        action,
      );
      await expect(
        prepareUpdateFailureReport({ attemptId: "untouched-install", result }),
      ).rejects.toThrow("Only a final failed update");
      await expectNoDatabase();
    }
    expect(JSON.stringify(output)).not.toContain(windowsUserSid);
    await expect(fs.readFile(path.join(root, "package.json"), "utf8")).resolves.toContain(
      '"2026.9.4"',
    );
    await expect(fs.stat(process.env.OPENCLAW_CONFIG_PATH!)).rejects.toMatchObject({
      code: "ENOENT",
    });
    if (terminal) {
      lines = [];
      await expect(updateCommand({ yes: true })).rejects.toMatchObject({ code: 0 });
      expect(lines.join("\n")).toContain(`OpenClaw update skipped: ${reason}`);
      expect(lines.join("\n")).toContain(action);
      expect(lines.join("\n")).not.toContain("rollback");
      if (kind === "brew") {
        expect(lines.join("\n")).toContain("openclaw gateway restart");
      }
    }
    expect(triage).not.toHaveBeenCalled();
    if (kind === "unmanaged" && database) {
      vi.spyOn(updateCheck, "resolveNpmChannelTag").mockResolvedValue({
        tag: "latest",
        version: "2026.9.4",
      });
      const finalize = vi.spyOn(finalization, "updateFinalizeCommand").mockResolvedValue();
      await updateRepairCommand({ json: true, yes: true });
      expect(finalize).not.toHaveBeenCalled();
      expect(listUpdateRuns({ limit: 1 })[0]?.steps).toContainEqual(
        expect.objectContaining({ step: "reconcile:acknowledged", status: "completed" }),
      );
    }
  },
);

it.each(["missing", "invalid"])(
  "explains an unclassified root with a %s manifest before fetching target metadata",
  async (manifest) => {
    const manifestPath = path.join(root, "package.json");
    if (manifest === "missing") {
      await fs.unlink(manifestPath);
      await fs.rmdir(path.join(root, "dist"));
    } else {
      await fs.writeFile(manifestPath, "{invalid json");
    }
    vi.spyOn(container, "isContainerEnvironment").mockReturnValue(false);
    vi.spyOn(servicePlan, "isGatewayServiceManagementAllowedForUpdate").mockReturnValue(false);
    const metadata = vi
      .spyOn(packageMetadata, "fetchNpmPackageTargetStatus")
      .mockRejectedValue(new Error("Unclassified roots must not query target metadata"));
    const channel = vi
      .spyOn(updateCheck, "resolveNpmChannelTag")
      .mockRejectedValue(new Error("Unclassified roots must not resolve a channel"));

    await expect(updateCommand({ dryRun: true, json: true, yes: true })).rejects.toMatchObject({
      code: 0,
    });

    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({
      status: "skipped",
      mode: "unknown",
      reason: "unmanaged-package-install",
    });
    expect(JSON.stringify(output)).toContain("openclaw gateway status --deep and npm root -g");
    expect(metadata).not.toHaveBeenCalled();
    expect(channel).not.toHaveBeenCalled();
    expect(triage).not.toHaveBeenCalled();
    await expectNoDatabase();
    if (manifest === "missing") {
      expect(await fs.readdir(root)).toEqual([]);
    } else {
      expect(await fs.readFile(manifestPath, "utf8")).toBe("{invalid json");
    }
  },
);
