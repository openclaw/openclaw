import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred, nextEventLoopTurn } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as exec from "../process/exec.js";
import { pkgQueryResult as result } from "./update-freebsd-pkg-ownership.test-support.js";
import { UpdatePreMutationError } from "./update-pre-mutation-error.js";
import { createSystemPackageOwnershipInspection } from "./update-system-package-ownership.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => vi.spyOn(process, "platform", "get").mockReturnValue("freebsd"));
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function fixture(inventory = "", timeout = 100) {
  const onWarning = vi.fn();
  const query = vi.spyOn(exec, "runCommandBuffered").mockResolvedValue(result(inventory));
  const inspection = createSystemPackageOwnershipInspection(timeout, { onWarning });
  return { query, onWarning, inspect: inspection.assertUnowned };
}
function expectWarning(onWarning: ReturnType<typeof vi.fn>, text: string) {
  expect(onWarning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(text));
  expect(onWarning.mock.calls[0]?.[0]).not.toMatch(
    /private database|private configuration|\/fixture|private path|fixture-secret|PRIVATE_CUSTOM_CODE/u,
  );
}
async function inspectTwice(inspect: ReturnType<typeof fixture>["inspect"]) {
  await expect(inspect("/fixture/openclaw")).resolves.toBeUndefined();
  await expect(inspect("/another/root")).resolves.toBeUndefined();
}
it("uses one non-bootstrap, alias-pinned inventory for a planning snapshot", async () => {
  const { inspect, query } = fixture("", 321);
  await inspectTwice(inspect);
  expect(query).toHaveBeenCalledExactlyOnceWith(["/usr/sbin/pkg", "-N", "query", "-a", "%Fp"], {
    timeoutMs: 321,
    env: { ALIAS: "query=query", PKG_ENABLE_PLUGINS: "no" },
    maxOutputBytes: { stdout: 16 * 1024 * 1024, stderr: 64 * 1024 },
  });
});
it("warns once and continues after timeout without consulting the host", async () => {
  for (const platform of ["linux", "freebsd"] as const) {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const onWarning = vi.fn();
    const runCommand = vi.spyOn(exec, "runCommandBuffered");
    runCommand.mockClear().mockResolvedValue(result("", { code: null, termination: "timeout" }));
    const inspection = createSystemPackageOwnershipInspection(100, { onWarning });
    await expect(inspection.assertUnowned("/fixture/openclaw")).resolves.toBeUndefined();
    await expect(inspection.assertEntryUnowned("/fixture/launcher")).resolves.toBeUndefined();
    expect(runCommand).toHaveBeenCalledOnce();
    expectWarning(onWarning, "Continuing without verified system-package ownership");
  }
});
it("retains the pre-mutation error contract for a positive linux owner", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const { inspect, onWarning } = fixture("/fixture/openclaw/package.json\n");
  const failure = inspect("/fixture/openclaw");
  await expect(failure).rejects.toBeInstanceOf(UpdatePreMutationError);
  await expect(failure).rejects.toMatchObject({
    name: "UpdatePreMutationError",
    reason: "pacman-owned-install",
    owned: true,
  });
  expect(onWarning).not.toHaveBeenCalled();
});
it.each(["directory", "file", "root"] as const)(
  "resolves package ownership through a %s alias",
  async (kind) => {
    const base = dirs.make("pkg-alias-");
    const root = path.join(base, "root");
    const alias = path.join(base, "alias");
    await fs.mkdir(root, { recursive: true });
    let candidate = root;
    let registered: string;
    if (kind === "directory") {
      await fs.symlink(root, alias, "dir");
      registered = path.join(alias, "package.json");
    } else if (kind === "file") {
      await fs.writeFile(path.join(root, "openclaw.mjs"), "fixture");
      await fs.symlink(path.join(root, "openclaw.mjs"), alias);
      registered = alias;
    } else {
      const indirect = path.join(base, "indirect");
      await fs.mkdir(indirect);
      await fs.symlink(root, path.join(indirect, "openclaw"), "dir");
      await fs.symlink(indirect, alias, "dir");
      candidate = path.join(alias, "openclaw");
      registered = path.join(indirect, "openclaw");
    }
    const pending = fixture(registered + "\n", 1000).inspect(candidate);
    if (kind === "file") {
      await pending;
    } else {
      await expect(pending).rejects.toMatchObject({ reason: "pkg-owned-install" });
    }
  },
);
it("warns after lstat failure without private details", async () => {
  const { inspect, onWarning } = fixture("/registered/file\n");
  vi.spyOn(fs, "lstat").mockRejectedValue(
    Object.assign(new Error("private path token=fixture-secret"), { code: "EACCES" }),
  );
  await expect(inspect("/fixture/openclaw")).resolves.toBeUndefined();
  expectWarning(onWarning, "lstat");
});
it("does not continue an ancestor walk or reset the snapshot after a late ENOENT", async () => {
  const { inspect, query, onWarning } = fixture("/registered/file\n");
  const lookupResult = createDeferred<never>();
  const lookup = vi.spyOn(fs, "lstat").mockImplementationOnce(() => lookupResult.promise);
  const canonical = vi.spyOn(fs, "realpath");
  vi.useFakeTimers();
  const pending = expect(inspect("/fixture/missing/openclaw")).resolves.toBeUndefined();
  await Promise.all([pending, vi.advanceTimersByTimeAsync(100)]);
  lookupResult.reject(Object.assign(new Error("missing"), { code: "ENOENT" }));
  await vi.advanceTimersByTimeAsync(0);
  await expect(inspect("/another/root")).resolves.toBeUndefined();
  expectWarning(onWarning, "exhausted its shared 100 ms budget");
  expect([query.mock.calls.length, lookup.mock.calls.length, canonical.mock.calls.length]).toEqual([
    1, 1, 0,
  ]);
});
it.each(["query", "path"] as const)(
  "warns when %s work synchronously consumes the deadline",
  async (stage) => {
    const { inspect, query, onWarning } = fixture();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    query.mockImplementation(async () => {
      if (stage === "query") {
        clock.mockReturnValue(now + 101);
      }
      return result();
    });
    const lookup = vi.spyOn(fs, "lstat").mockImplementation(async () => {
      clock.mockReturnValue(now + 101);
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    const canonical = vi.spyOn(fs, "realpath");
    await inspectTwice(inspect);
    expectWarning(onWarning, "exhausted its shared 100 ms budget");
    // Observe any rejection orphaned by deadline admission.
    await nextEventLoopTurn();
    expect([
      query.mock.calls.length,
      lookup.mock.calls.length,
      canonical.mock.calls.length,
    ]).toEqual([1, stage === "query" ? 0 : 1, 0]);
  },
);
it("caps the inspection independently of a long installation timeout", async () => {
  const { inspect, query, onWarning } = fixture("", 20 * 60_000);
  query.mockImplementation(() => new Promise<never>(() => {}));
  vi.useFakeTimers();
  const pending = expect(inspect("/fixture/openclaw")).resolves.toBeUndefined();
  await Promise.all([pending, vi.advanceTimersByTimeAsync(30_000)]);
  expectWarning(onWarning, "exhausted its shared 30000 ms budget during pkg query");
  expect(query).toHaveBeenCalledWith(
    expect.any(Array),
    expect.objectContaining({ timeoutMs: 30_000 }),
  );
});
