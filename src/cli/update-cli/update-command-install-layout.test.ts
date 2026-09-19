import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as nodeRuntime from "../../commands/node-runtime-diagnostics.js";
import * as container from "../../infra/container-environment.js";
import * as packageMetadata from "../../infra/update-check-package-target.js";
import * as updateCheck from "../../infra/update-check.js";
import { prepareUpdateFailureReport } from "../../infra/update-failure-report-prepare.js";
import { listUpdateRuns } from "../../infra/update-run-ledger.js";
import {
  renderUpdateRunReport,
  updateRunReportInputFromResult,
} from "../../infra/update-run-report.js";
import { runGatewayUpdate } from "../../infra/update-runner.js";
import * as processRunner from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { isReportableUpdateRun } from "../../shared/update-outcome.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import * as shared from "./shared.js";
import { updateStatusCommand } from "./status.js";
import * as finalization from "./update-command-finalize.js";
import * as servicePlan from "./update-command-service-plan.js";
import { updateCommand } from "./update-command.js";
import { updateRepairCommand } from "./update-repair-command.js";

const triage = vi.hoisted(() => vi.fn());
vi.mock("../../infra/update-triage.js", () => ({
  prepareUpdateFailureTriage: async () => triage,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
let output: unknown[];
let lines: string[];

beforeEach(async () => {
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
    return {
      stdout: "",
      stderr: "not a global install or Git checkout",
      code: 1,
      signal: null,
      killed: false,
      termination: "exit",
    };
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

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([
  { containerized: true, reason: "container-image-install", action: "Pull or build" },
  { containerized: false, reason: "unmanaged-package-install", action: "Reinstall" },
])(
  "records the $reason non-outcome in CLI JSON, history and report eligibility",
  async ({ containerized, reason, action }) => {
    openOpenClawStateDatabase();
    vi.spyOn(container, "isContainerEnvironment").mockReturnValue(containerized);
    await expect(updateCommand({ json: true, yes: true, channel: "stable" })).rejects.toMatchObject(
      { code: 0 },
    );
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({
      status: "skipped",
      reason,
      before: { version: "2026.9.4" },
      steps: [
        expect.objectContaining({
          exitCode: 0,
          failureFacts: [expect.objectContaining({ code: "installation-unclassified" })],
        }),
      ],
    });
    expect(output[0]).not.toHaveProperty("recovery");
    const run = listUpdateRuns({ limit: 1 }, { env: process.env })[0]!;
    expect(run).toMatchObject({
      status: "skipped",
      reason,
      origin: { nextAction: expect.stringContaining(action) },
    });
    expect(renderUpdateRunReport(run).markdown).toContain(action);
    expect(isReportableUpdateRun(run)).toBe(false);
    expect(output[0]).toMatchObject({ runId: run.runId, run: { origin: run.origin } });
    expect(triage).not.toHaveBeenCalled();
    await expect(fs.readFile(path.join(root, "package.json"), "utf8")).resolves.toContain(
      '"2026.9.4"',
    );
    await expect(fs.stat(process.env.OPENCLAW_CONFIG_PATH!)).rejects.toMatchObject({
      code: "ENOENT",
    });
    if (!containerized) {
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

it.each([true, false])(
  "reports an untouched fresh profile (container: %s)",
  async (containerized) => {
    vi.spyOn(container, "isContainerEnvironment").mockReturnValue(containerized);
    await expect(updateCommand({ json: true, yes: true })).rejects.toMatchObject({ code: 0 });
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({
      status: "skipped",
      reason: containerized ? "container-image-install" : "unmanaged-package-install",
      before: { version: "2026.9.4" },
      steps: [
        expect.objectContaining({
          exitCode: 0,
          failureFacts: [expect.objectContaining({ code: "installation-unclassified" })],
        }),
      ],
    });
    expect(output[0]).not.toHaveProperty("recovery");
    expect(output[0]).not.toHaveProperty("runId");
    expect(triage).not.toHaveBeenCalled();
    await expect(fs.stat(resolveOpenClawStateSqlitePath(process.env))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it("renders the container non-outcome in terminal output", async () => {
  vi.spyOn(container, "isContainerEnvironment").mockReturnValue(true);
  await expect(updateCommand({ yes: true })).rejects.toMatchObject({ code: 0 });
  expect(lines.join("\n")).toContain("OpenClaw update skipped: container-image-install");
  expect(lines.join("\n")).toContain("Pull or build");
  expect(lines.join("\n")).not.toContain("rollback");
  expect(triage).not.toHaveBeenCalled();
});

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
      steps: [
        expect.objectContaining({
          exitCode: 0,
          failureFacts: [
            expect.objectContaining({
              check: "installation-inspection",
              code: "installation-unclassified",
              message: expect.stringContaining("openclaw gateway status --deep and npm root -g"),
            }),
          ],
        }),
      ],
    });
    const diagnostics = JSON.stringify(output[0]);
    expect(diagnostics).toContain(`Root: ${root}`);
    expect(diagnostics).toContain("Git metadata: absent or unreadable");
    expect(diagnostics).toContain("node_modules layout: outside node_modules");
    expect(diagnostics).toContain("package.json name: missing or unreadable");
    expect(diagnostics).toContain(
      "Service unit target: not inspected (service management unavailable)",
    );
    expect(diagnostics).toContain("retry openclaw update from the owning installation");
    expect(metadata).not.toHaveBeenCalled();
    expect(channel).not.toHaveBeenCalled();
    expect(triage).not.toHaveBeenCalled();
    await expect(fs.stat(resolveOpenClawStateSqlitePath(process.env))).rejects.toMatchObject({
      code: "ENOENT",
    });
    if (manifest === "missing") {
      expect(await fs.readdir(root)).toEqual([]);
    } else {
      expect(await fs.readFile(manifestPath, "utf8")).toBe("{invalid json");
    }
  },
);

it("keeps the Git runner's untouched container result out of failure reports", async () => {
  vi.spyOn(container, "isContainerEnvironment").mockReturnValue(true);
  const result = await runGatewayUpdate({
    cwd: root,
    argv1: path.join(root, "openclaw.mjs"),
    runCommand: processRunner.runCommandWithTimeout,
  });
  expect(result).toMatchObject({
    status: "skipped",
    mode: "unknown",
    reason: "container-image-install",
    steps: [],
  });
  expect(result.recovery).toBeUndefined();
  expect(renderUpdateRunReport(updateRunReportInputFromResult(result)).markdown).toContain(
    "Pull or build",
  );
  await expect(
    prepareUpdateFailureReport({ attemptId: "untouched-container", result }),
  ).rejects.toThrow("Only a final failed update");
});

it.skipIf(process.platform === "win32").each([false, true])(
  "reports Homebrew guidance across output and existing history (database: %s)",
  async (existingDatabase) => {
    if (existingDatabase) {
      openOpenClawStateDatabase();
    }
    const prefix = dirs.make("brew-cellar-");
    vi.stubEnv("HOMEBREW_PREFIX", prefix);
    const brewRoot = path.join(
      prefix,
      "Cellar",
      "openclaw-cli",
      "2026.9.4",
      "libexec",
      "lib",
      "node_modules",
      "openclaw",
    );
    await fs.mkdir(path.join(brewRoot, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(brewRoot, "package.json"),
      '{"name":"openclaw","version":"2026.9.4"}',
    );
    vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(brewRoot);
    vi.spyOn(process, "cwd").mockReturnValue(brewRoot);

    await expect(updateCommand({ json: true, yes: true })).rejects.toMatchObject({ code: 0 });
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({
      status: "skipped",
      reason: "unmanaged-package-install",
      before: { version: "2026.9.4" },
      steps: [],
    });
    expect(lines.join("\n")).toContain("brew upgrade openclaw-cli");
    if (existingDatabase) {
      const run = listUpdateRuns({ limit: 1 })[0]!;
      expect(run).toMatchObject({
        status: "skipped",
        origin: { nextAction: expect.stringContaining("brew upgrade openclaw-cli") },
      });
      expect(output[0]).toMatchObject({ runId: run.runId, run: { origin: run.origin } });
      const report = renderUpdateRunReport(run).markdown;
      expect(report).toContain("brew upgrade openclaw-cli");
      expect(report).toContain("openclaw gateway restart");
      expect(report.length).toBeLessThanOrEqual(1500);
      expect(isReportableUpdateRun(run)).toBe(false);
      vi.spyOn(nodeRuntime, "collectNodeRuntimeFindings").mockResolvedValue([]);
      vi.spyOn(updateCheck, "checkUpdateStatus").mockResolvedValue({
        root: brewRoot,
        installKind: "package",
        packageManager: "unknown",
      });
      await updateStatusCommand({ json: true });
      expect(output[1]).toMatchObject({
        lastRun: { runId: run.runId, status: "skipped", origin: run.origin },
      });
    } else {
      expect(output[0]).not.toHaveProperty("runId");
      await expect(fs.stat(resolveOpenClawStateSqlitePath(process.env))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }

    lines = [];
    await expect(updateCommand({ yes: true })).rejects.toMatchObject({ code: 0 });
    expect(lines.join("\n")).toContain("OpenClaw update skipped: unmanaged-package-install");
    expect(lines.join("\n")).toContain("brew upgrade openclaw-cli");
    expect(lines.join("\n")).toContain("openclaw gateway restart");
    expect(triage).not.toHaveBeenCalled();
  },
);
