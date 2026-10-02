import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { resolveInitialDoctorHealthContributions } from "./doctor-health-contributions-initial.js";
import { createDoctorHealthFlowContext } from "./doctor-health-contributions.test-support.js";
import type { HealthCheckContext } from "./health-checks.js";

vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: vi.fn(),
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
let globalRoot: string;
const context: HealthCheckContext = {
  mode: "lint",
  cfg: {},
  env: {},
  runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
};

function contribution() {
  return resolveInitialDoctorHealthContributions({
    runStructuredHealthRepairs: vi.fn(),
    runGatewayConfigHealth: vi.fn(),
    runAuthProfileMigration: vi.fn(),
    runAuthProfileHealth: vi.fn(),
    runGatewayAuthHealth: vi.fn(),
    runLegacyStateHealth: vi.fn(),
  }).find((entry) => entry.id === "doctor:update-snapshots");
}

function check() {
  return contribution()?.healthChecks[0];
}

beforeEach(async () => {
  globalRoot = path.join(
    dirs.make("doctor-update-snapshots-"),
    "operator's prefix",
    "lib",
    "node_modules",
  );
  await fs.mkdir(path.join(globalRoot, "openclaw"), { recursive: true });
  vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(path.join(globalRoot, "openclaw"));
});

afterEach(() => vi.restoreAllMocks());

async function snapshot(name: string, bytes: number) {
  const directory = path.join(globalRoot, `.openclaw.package-backup-${name}.databases`);
  await fs.mkdir(path.join(directory, "nested"), { recursive: true });
  await fs.writeFile(path.join(directory, "nested", "state.sqlite"), Buffer.alloc(bytes));
  return directory;
}

it("reports snapshots retired under the dashed name after a cleanup I/O failure", async () => {
  const retired = path.join(globalRoot, ".openclaw-package-backup-3-300.databases");
  await fs.mkdir(retired);
  await fs.writeFile(path.join(retired, "state.sqlite"), Buffer.alloc(512));

  const findings = (await check()?.detect(context)) ?? [];
  expect(findings).toHaveLength(1);
  expect(findings[0]?.message).toContain(
    "1 retained pre-migration database snapshot directory: 512 bytes",
  );
  expect(findings[0]?.message).toContain(path.basename(retired));
});

it("reports snapshot sizes and quoted removal commands without offering or performing repair", async () => {
  const first = await snapshot("1-100", 1024);
  const second = await snapshot("2-200", 2048);
  await fs.mkdir(path.join(globalRoot, ".openclaw.package-backup-unrelated"));
  await fs.mkdir(path.join(globalRoot, "unrelated.databases"));
  await fs.writeFile(path.join(globalRoot, ".openclaw.package-backup-file.databases"), "ignore");
  await fs.symlink(second, path.join(first, "linked-snapshot"), "dir");
  await fs.symlink(second, path.join(globalRoot, ".openclaw.package-backup-link.databases"), "dir");

  const findings = (await check()?.detect({ ...context, mode: "fix" })) ?? [];
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({
    checkId: "core/doctor/update-snapshots",
    severity: "warning",
  });
  const message = findings[0]!.message;
  expect(message).toContain(
    "2 retained pre-migration database snapshot directories: 3072 bytes (3.0 KiB)",
  );
  for (const directory of [first, second]) {
    const command =
      process.platform === "win32"
        ? `Remove-Item -LiteralPath '${directory.replaceAll("'", "''")}' -Recurse -Force`
        : `rm -rf -- '${directory.replaceAll("'", "'\\''")}'`;
    expect(message).toContain(command);
    expect((await fs.stat(directory)).isDirectory()).toBe(true);
  }
  expect(message).not.toContain("unrelated");
  expect(message).toContain(
    "confirm no update is in progress and no recovery needs these snapshots",
  );
  expect(typeof check()?.repair).toBe("undefined");
});

it("does not report a finding without snapshot directories or outside an npm global layout", async () => {
  expect(await check()?.detect(context)).toEqual([]);
  vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(
    path.join(globalRoot, "missing", "lib", "node_modules", "openclaw"),
  );
  expect(await check()?.detect(context)).toEqual([]);
  await snapshot("1-100", 1024);
  vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(
    path.join(globalRoot, "source", "openclaw"),
  );
  expect(await check()?.detect(context)).toEqual([]);
});

it.each(["budget", "read-error"])(
  "warns when a %s interrupts inspection before any snapshot is found",
  async (cause) => {
    await snapshot("1-100", 1024);
    if (cause === "budget") {
      vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(201);
    } else {
      vi.spyOn(fs, "opendir").mockRejectedValueOnce(
        Object.assign(new Error("cannot read global root"), { code: "EACCES" }),
      );
    }
    const findings = await check()?.detect(context);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]).toMatchObject({
      checkId: "core/doctor/update-snapshots",
      severity: "warning",
    });
    expect(findings?.[0]?.message).toContain("Inspection was incomplete");
    expect(findings?.[0]?.message).toContain(globalRoot);
    expect(findings?.[0]?.message).toContain(".openclaw.package-backup-*.databases");
  },
);

it.each([
  "OPENCLAW_UPDATE_IN_PROGRESS",
  "OPENCLAW_UPDATE_POST_CORE_CONVERGENCE",
  "OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE",
])("defers snapshot discovery under the shipped updater marker %s", async (marker) => {
  await snapshot("1-100", 1024);
  const ctx = createDoctorHealthFlowContext({ env: { [marker]: "1" } });
  await contribution()?.run(ctx);
  expect(ctx.runtime.log).not.toHaveBeenCalled();
  expect(ctx.runtime.error).not.toHaveBeenCalled();
});

it("reports a lower bound when inspection exceeds its time budget", async () => {
  await snapshot("1-100", 1024);
  const opendir = fs.opendir.bind(fs);
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
    const directory = await opendir(...args);
    if (String(args[0]).endsWith(".databases")) {
      clock.mockReturnValue(201);
    }
    return directory;
  });
  const findings = await check()?.detect(context);
  expect(findings?.[0]?.message).toContain("at least 0 bytes");
  expect(findings?.[0]?.message).toContain("paths and size may be partial");
});
