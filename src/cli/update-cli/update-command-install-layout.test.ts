import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as container from "../../infra/container-environment.js";
import * as packageMetadata from "../../infra/update-check-package-target.js";
import * as updateCheck from "../../infra/update-check.js";
import { listUpdateRuns } from "../../infra/update-run-ledger.js";
import * as windowsUser from "../../infra/windows-user-sid.js";
import * as processRunner from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { createCommandResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import * as releaseUpdate from "../../update/cli.js";
import * as shared from "./shared.js";
import * as servicePlan from "./update-command-service-plan.js";
import { updateCommand } from "./update-command.js";

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

it.runIf(process.platform === "darwin")(
  "reports missing developer tools for a source update without a confirmed package owner",
  async () => {
    await fs.mkdir(path.join(root, ".git"));
    vi.stubEnv("PATH", "/usr/bin:/bin");
    vi.spyOn(releaseUpdate, "runReleaseUpdateCli").mockRejectedValue(
      new Error("A checkout with unavailable Git must not enter package release preparation"),
    );
    const command = vi.mocked(processRunner.runCommandWithTimeout);
    const run = command.getMockImplementation()!;
    command.mockImplementation((argv, options) =>
      argv[0] === "/usr/bin/xcode-select"
        ? Promise.resolve(createCommandResult({ code: 2 }))
        : run(argv, options),
    );
    await expect(updateCommand({ json: true, yes: true, restart: false })).rejects.toMatchObject({
      code: 1,
    });
    expect(output[0]).toMatchObject({ status: "error", reason: "git-version-unsupported" });
    expect(lines.join("\n")).toContain("xcode-select --install");
    expect(command.mock.calls.some(([argv]) => argv[0] === "git")).toBe(false);
  },
);

const expectNoDatabase = () =>
  expect(fs.stat(resolveOpenClawStateSqlitePath(process.env))).rejects.toMatchObject({
    code: "ENOENT",
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

it.skipIf(process.platform === "win32").each([false, true])(
  "reports Homebrew guidance without changing profile history (database: %s)",
  async (existingDatabase) => {
    vi.spyOn(container, "isContainerEnvironment").mockReturnValue(false);
    if (existingDatabase) {
      openOpenClawStateDatabase();
    }
    const prefix = dirs.make("brew-cellar-");
    vi.stubEnv("HOMEBREW_PREFIX", prefix);
    const brewRoot = path.join(
      prefix,
      "Cellar/openclaw-cli/2026.9.4/libexec/lib/node_modules/openclaw",
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
      expect(listUpdateRuns({ limit: 1 })).toEqual([]);
    } else {
      expect(output[0]).not.toHaveProperty("runId");
      await expectNoDatabase();
    }

    lines = [];
    await expect(updateCommand({ yes: true })).rejects.toMatchObject({ code: 0 });
    expect(lines.join("\n")).toContain("OpenClaw update skipped: unmanaged-package-install");
    expect(lines.join("\n")).toContain("brew upgrade openclaw-cli");
    expect(lines.join("\n")).toContain("openclaw gateway restart");
    expect(triage).not.toHaveBeenCalled();
  },
);
