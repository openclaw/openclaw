import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveExistingPreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";

const check = CORE_HEALTH_CHECKS.find(
  (entry) => entry.id === "core/doctor/session-archive-read-cache",
)!;

vi.mock("../infra/tmp-openclaw-dir.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/tmp-openclaw-dir.js")>()),
  resolveExistingPreferredOpenClawTmpDir: vi.fn(),
}));
const ctx = { mode: "fix" as const, cfg: {}, runtime: { log() {}, error() {}, exit() {} } };
const name = "0123456789abcdef0123456789abcdef-10-1700000000000.jsonl";
let root: string;
let cache: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "archive-cache-"));
  cache = path.join(root, "session-archive-read-cache");
  vi.mocked(resolveExistingPreferredOpenClawTmpDir).mockReturnValue(root);
  await fs.mkdir(cache);
  await fs.writeFile(path.join(cache, name), "plaintext");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
it("reports without deleting, repairs, and stays clean on a second run", async () => {
  expect(await check.detect({ ...ctx, mode: "lint" })).toMatchObject([
    { message: expect.stringContaining("9 bytes") },
  ]);
  await check.repair!({ ...ctx, dryRun: true }, []);
  expect(await fs.readFile(path.join(cache, name), "utf8")).toBe("plaintext");
  await fs.writeFile(
    path.join(cache, name + ".123.01234567-89ab-cdef-0123-456789abcdef.tmp"),
    "partial",
  );
  await check.repair!(ctx, []);
  await expect(fs.stat(cache)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await check.detect(ctx)).toEqual([]);
});
it("leaves unrelated files, directories, and file symlinks alone", async () => {
  await fs.writeFile(path.join(cache, "notes.txt"), "keep");
  await fs.mkdir(path.join(cache, name.replace("-10-", "-12-")));
  await fs.symlink(path.join(cache, "notes.txt"), path.join(cache, name.replace("-10-", "-11-")));
  await check.repair!(ctx, []);
  expect((await fs.readdir(cache)).toSorted()).toEqual(
    [name.replace("-10-", "-12-"), name.replace("-10-", "-11-"), "notes.txt"].toSorted(),
  );
  expect(await check.detect(ctx)).toMatchObject([
    { message: expect.stringContaining("4 bytes in 3 entries") },
  ]);
});
it.each(process.getuid ? ["symlink", "foreign owner"] : ["symlink"])(
  "refuses a %s directory",
  async (kind) => {
    if (kind === "symlink") {
      await fs.rename(cache, path.join(root, "target"));
      await fs.symlink(path.join(root, "target"), cache, "dir");
    } else {
      vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
    }
    expect(await check.detect(ctx)).toMatchObject([
      { message: expect.stringContaining("Refusing") },
    ]);
    expect(await check.repair!(ctx, [])).toMatchObject({
      changes: [],
      warnings: [expect.stringContaining("Refusing")],
    });
    expect(await fs.readFile(path.join(cache, name), "utf8")).toBe("plaintext");
  },
);

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "reports files left after a refused unlink without failing repair",
  async () => {
    await fs.chmod(cache, 0o500);
    try {
      expect(await check.repair!(ctx, [])).toMatchObject({
        changes: [],
        warnings: [expect.any(String)],
      });
      expect(await check.detect(ctx)).toMatchObject([
        { message: expect.stringContaining("9 bytes") },
      ]);
    } finally {
      await fs.chmod(cache, 0o700);
    }
  },
);
