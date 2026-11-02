import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import {
  createDoctorHealthFlowContext,
  resolveDoctorHealthContributions,
} from "./doctor-health-contributions.test-support.js";
import type { HealthFinding } from "./health-checks.js";

vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: vi.fn(),
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
let globalRoot: string;
const context = { ...createDoctorHealthFlowContext(), mode: "lint" as const, env: {} };
const contribution = resolveDoctorHealthContributions().find(
  (entry) => entry.id === "doctor:update-snapshots",
);
const check = contribution?.healthChecks[0];

function warningMessage(findings: readonly HealthFinding[] | undefined) {
  expect(findings).toEqual([
    expect.objectContaining({ checkId: "core/doctor/update-snapshots", severity: "warning" }),
  ]);
  return findings![0]!.message;
}

function packageRoot(...segments: string[]) {
  vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(path.join(globalRoot, ...segments));
}

beforeEach(async () => {
  globalRoot = path.join(dirs.make("snapshots-"), "operator's prefix", "lib", "node_modules");
  await fs.mkdir(path.join(globalRoot, "openclaw"), { recursive: true });
  packageRoot("openclaw");
});

afterEach(() => vi.restoreAllMocks());

async function snapshot(name: string, bytes: number, separator = ".") {
  const directory = path.join(globalRoot, `.openclaw${separator}package-backup-${name}.databases`);
  await fs.mkdir(path.join(directory, "nested"), { recursive: true });
  await fs.writeFile(path.join(directory, "nested", "state.sqlite"), Buffer.alloc(bytes));
  return directory;
}

it("reports dotted and retired dashed snapshots with sizes and quoted commands, without repair", async () => {
  const first = await snapshot("1-100", 1024);
  const second = await snapshot("2-200", 2048, "-");
  await fs.mkdir(path.join(globalRoot, ".openclaw.package-backup-unrelated"));
  await fs.mkdir(path.join(globalRoot, "unrelated.databases"));
  await fs.writeFile(path.join(globalRoot, ".openclaw.package-backup-file.databases"), "ignore");
  await fs.symlink(second, path.join(first, "linked-snapshot"), "dir");
  await fs.symlink(second, path.join(globalRoot, ".openclaw.package-backup-link.databases"), "dir");

  const message = warningMessage(await check?.detect({ ...context, mode: "fix" }));
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
  expect(typeof check?.repair).toBe("undefined");
});

it("does not report a finding without snapshot directories or outside an npm global layout", async () => {
  expect(await check?.detect(context)).toEqual([]);
  packageRoot("missing", "lib", "node_modules", "openclaw");
  expect(await check?.detect(context)).toEqual([]);
  await snapshot("1-100", 1024);
  packageRoot("source", "openclaw");
  expect(await check?.detect(context)).toEqual([]);
});

it.each(["budget", "read-error", "size-budget"])(
  "warns when %s interrupts snapshot inspection",
  async (cause) => {
    await snapshot("1-100", 1024);
    if (cause === "budget") {
      vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(201);
    } else if (cause === "read-error") {
      vi.spyOn(fs, "opendir").mockRejectedValueOnce(
        Object.assign(new Error("cannot read global root"), { code: "EACCES" }),
      );
    } else {
      const opendir = fs.opendir.bind(fs);
      const clock = vi.spyOn(performance, "now").mockReturnValue(0);
      vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
        const directory = await opendir(...args);
        if (String(args[0]).endsWith(".databases")) {
          clock.mockReturnValue(201);
        }
        return directory;
      });
    }
    const message = warningMessage(await check?.detect(context));
    if (cause === "size-budget") {
      expect(message).toContain("at least 0 bytes");
      expect(message).toContain("paths and size may be partial");
    } else {
      expect(message).toContain("Inspection was incomplete");
      expect(message).toContain(globalRoot);
      expect(message).toContain(".openclaw.package-backup-*.databases");
    }
  },
);

it.each([
  "OPENCLAW_UPDATE_IN_PROGRESS",
  "OPENCLAW_UPDATE_POST_CORE_CONVERGENCE",
  "OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE",
])("defers snapshot discovery under the shipped updater marker %s", async (marker) => {
  await snapshot("1-100", 1024);
  const ctx = createDoctorHealthFlowContext({ env: { [marker]: "1" } });
  await contribution?.run(ctx);
  expect(ctx.runtime.log).not.toHaveBeenCalled();
  expect(ctx.runtime.error).not.toHaveBeenCalled();
});
