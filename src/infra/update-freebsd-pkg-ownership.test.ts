import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as exec from "../process/exec.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import {
  createFreeBsdPkgOwnershipInspection,
  FreeBsdPkgOwnershipError,
} from "./update-freebsd-pkg-ownership.js";
import { pkgQueryResult as result } from "./update-freebsd-pkg-ownership.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("FreeBSD pkg ownership", () => {
  it.each(["linux", "darwin", "win32"] as const)("does not inspect pkg on %s", async (platform) => {
    const query = vi.spyOn(exec, "runCommandBuffered");
    await withMockedPlatform(platform, () =>
      createFreeBsdPkgOwnershipInspection(100).assertUnowned("/fixture/openclaw"),
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("uses one non-bootstrap, alias-pinned inventory for a planning snapshot", async () => {
    await withTestDir({ prefix: "openclaw-pkg-inventory-" }, async (base) => {
      const query = vi.spyOn(exec, "runCommandBuffered").mockResolvedValue(result());
      await withMockedPlatform("freebsd", async () => {
        const inspection = createFreeBsdPkgOwnershipInspection(321);
        await inspection.assertUnowned(path.join(base, "first"));
        await inspection.assertUnowned(path.join(base, "second"));
      });
      expect(query).toHaveBeenCalledExactlyOnceWith(["/usr/sbin/pkg", "-N", "query", "-a", "%Fp"], {
        timeoutMs: 321,
        env: { ALIAS: "query=query", PKG_ENABLE_PLUGINS: "no" },
        maxOutputBytes: { stdout: 16 * 1024 * 1024, stderr: 64 * 1024 },
      });
    });
  });

  it.each([
    { name: "missing owner or unavailable database", value: result("", { code: 1 }) },
    { name: "timeout", value: result("", { code: null, termination: "timeout" }) },
    { name: "truncated inventory", value: result("", { termination: "output-limit" }) },
    {
      name: "nonfatal configuration error",
      value: result("", { stderr: Buffer.from("configuration error") }),
    },
    { name: "invalid UTF-8", value: result("", { stdout: Buffer.from([0xff, 0x0a]) }) },
    { name: "partial final record", value: result("/fixture/entry") },
    { name: "relative entry", value: result("relative/entry\n") },
    { name: "empty record", value: result("\n") },
  ])("preserves unknown ownership for $name", async ({ value }) => {
    vi.spyOn(exec, "runCommandBuffered").mockResolvedValue(value);
    await withMockedPlatform("freebsd", async () => {
      await expect(
        createFreeBsdPkgOwnershipInspection(100).assertUnowned("/fixture/openclaw"),
      ).rejects.toMatchObject({ reason: "pkg-ownership-unavailable" });
    });
  });

  it("preserves launch failure as unknown without exposing subprocess details", async () => {
    const cause = Object.assign(new Error("private database detail"), { code: "EACCES" });
    vi.spyOn(exec, "runCommandBuffered").mockRejectedValue(cause);
    await withMockedPlatform("freebsd", async () => {
      const failed = createFreeBsdPkgOwnershipInspection(100).assertUnowned("/fixture/openclaw");
      await expect(failed).rejects.toMatchObject({
        reason: "pkg-ownership-unavailable",
        cause,
        message: expect.stringMatching(
          /^FreeBSD pkg inspection failed during pkg query \(EACCES\)\./u,
        ),
      });
      const error = await failed.catch((caught: unknown) => caught);
      if (!(error instanceof FreeBsdPkgOwnershipError)) {
        throw new Error("Expected pkg inspection refusal");
      }
      expect(error.cause).toBe(cause);
      await expect(failed).rejects.not.toThrow("private database detail");
    });
  });

  it.each(["direct", "invoking alias", "registered alias"])(
    "detects a custom-prefix package through %s",
    async (kind) => {
      await withTestDir({ prefix: "openclaw-pkg-alias-" }, async (base) => {
        const prefix = path.join(base, "custom prefix");
        const root = path.join(prefix, "lib", "node_modules", "openclaw");
        await fs.mkdir(root, { recursive: true });
        const alias = path.join(base, "alias");
        await fs.symlink(prefix, alias, "dir");
        const registeredRoot =
          kind === "registered alias" ? path.join(alias, "lib", "node_modules", "openclaw") : root;
        vi.spyOn(exec, "runCommandBuffered").mockResolvedValue(
          result(`${registeredRoot}/package.json\n`),
        );
        await withMockedPlatform("freebsd", async () => {
          await expect(
            createFreeBsdPkgOwnershipInspection(1000).assertUnowned(
              kind === "invoking alias"
                ? path.join(alias, "lib", "node_modules", "openclaw")
                : root,
            ),
          ).rejects.toMatchObject({ reason: "pkg-owned-install" });
        });
      });
    },
  );

  it("does not treat a package-owned file symlink as ownership of its external target", async () => {
    await withTestDir({ prefix: "openclaw-pkg-file-link-" }, async (base) => {
      const root = path.join(base, "openclaw");
      await fs.mkdir(root);
      await fs.writeFile(path.join(root, "openclaw.mjs"), "fixture");
      const launcher = path.join(base, "launcher");
      await fs.symlink(path.join(root, "openclaw.mjs"), launcher);
      vi.spyOn(exec, "runCommandBuffered").mockResolvedValue(result(`${launcher}\n`));
      await withMockedPlatform("freebsd", () =>
        createFreeBsdPkgOwnershipInspection(1000).assertUnowned(root),
      );
    });
  });

  it("preserves ownership of a root symlink reached through a parent alias", async () => {
    await withTestDir({ prefix: "openclaw-pkg-root-link-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const target = path.join(base, "user", "openclaw");
      await fs.mkdir(prefix);
      await fs.mkdir(target, { recursive: true });
      await fs.symlink(target, path.join(prefix, "openclaw"), "dir");
      await fs.symlink(prefix, path.join(base, "alias"), "dir");
      vi.spyOn(exec, "runCommandBuffered").mockResolvedValue(result(`${prefix}/openclaw\n`));
      await withMockedPlatform("freebsd", async () => {
        await expect(
          createFreeBsdPkgOwnershipInspection(1000).assertUnowned(
            path.join(base, "alias", "openclaw"),
          ),
        ).rejects.toMatchObject({ reason: "pkg-owned-install" });
      });
    });
  });

  it("reports a lexical owner before inspecting unrelated inaccessible package paths", async () => {
    const root = "/fixture/openclaw";
    vi.spyOn(exec, "runCommandBuffered").mockResolvedValue(
      result(`/unreadable/file\n${root}/package.json\n`),
    );
    const canonical = vi
      .spyOn(fs, "realpath")
      .mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
    await withMockedPlatform("freebsd", async () => {
      await expect(
        createFreeBsdPkgOwnershipInspection(100).assertUnowned(root),
      ).rejects.toMatchObject({ reason: "pkg-owned-install" });
    });
    expect(canonical).not.toHaveBeenCalled();
  });

  it.each([
    { operation: "lstat", code: "EACCES" },
    { operation: "realpath", code: "EACCES" },
    { operation: "realpath", code: "ENOENT" },
    { operation: "realpath", code: "PRIVATE_CUSTOM_CODE" },
  ] as const)(
    "retains the actual $operation failure ($code) without private details",
    async ({ operation, code }) => {
      await withTestDir({ prefix: "openclaw-pkg-denied-" }, async (base) => {
        vi.spyOn(exec, "runCommandBuffered").mockResolvedValue(result(`${base}/registered/file\n`));
        const cause = Object.assign(
          new Error("denied /private/fixture/database token=fixture-secret"),
          { code },
        );
        vi.spyOn(fs, operation).mockRejectedValue(cause);
        await withMockedPlatform("freebsd", async () => {
          const failed = createFreeBsdPkgOwnershipInspection(100).assertUnowned(
            path.join(base, "openclaw"),
          );
          await expect(failed).rejects.toThrow("registered package directories");
          const error = await failed.catch((caught: unknown) => caught);
          expect(error).toBeInstanceOf(FreeBsdPkgOwnershipError);
          if (!(error instanceof FreeBsdPkgOwnershipError)) {
            throw new Error("Expected pkg inspection refusal");
          }
          expect(error.cause).toBe(cause);
          expect(error.reason).toBe("pkg-ownership-unavailable");
          const suffix = code === "PRIVATE_CUSTOM_CODE" ? "" : ` (${code})`;
          expect(
            error.message.startsWith(
              `FreeBSD pkg inspection failed during ${operation}${suffix}. `,
            ),
          ).toBe(true);
          expect(error.message).not.toMatch(/private|fixture-secret|PRIVATE_CUSTOM_CODE/u);
          expect(error).not.toHaveProperty("code");
        });
      });
    },
  );

  it("preserves an inner domain refusal through nested path resolution", async () => {
    vi.spyOn(exec, "runCommandBuffered").mockResolvedValue(result());
    const error = new FreeBsdPkgOwnershipError("pkg-ownership-unavailable", "paths");
    vi.spyOn(fs, "lstat").mockRejectedValue(error);
    await withMockedPlatform("freebsd", async () => {
      await expect(
        createFreeBsdPkgOwnershipInspection(100).assertUnowned("/fixture/openclaw"),
      ).rejects.toBe(error);
    });
  });

  it("does not continue an ancestor walk or reset the snapshot after a late ENOENT", async () => {
    const query = vi
      .spyOn(exec, "runCommandBuffered")
      .mockResolvedValue(result("/registered/file\n"));
    let rejectLookup: ((error: Error) => void) | undefined;
    const lookup = vi.spyOn(fs, "lstat").mockImplementationOnce(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectLookup = reject;
        }),
    );
    const canonical = vi.spyOn(fs, "realpath");
    vi.useFakeTimers();
    await withMockedPlatform("freebsd", async () => {
      const inspection = createFreeBsdPkgOwnershipInspection(100);
      const pending = expect(
        inspection.assertUnowned("/fixture/missing/openclaw"),
      ).rejects.toMatchObject({
        reason: "pkg-ownership-unavailable",
        message: expect.stringContaining("exhausted its shared 100 ms budget"),
      });
      await vi.advanceTimersByTimeAsync(100);
      await pending;
      rejectLookup?.(Object.assign(new Error("missing"), { code: "ENOENT" }));
      await vi.advanceTimersByTimeAsync(0);
      await expect(inspection.assertUnowned("/another/root")).rejects.toMatchObject({
        reason: "pkg-ownership-unavailable",
        message: expect.stringContaining(
          "exhausted its shared 100 ms budget during path inspection",
        ),
      });
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(canonical).not.toHaveBeenCalled();
  });

  it.each(["query", "path"] as const)(
    "observes rejection when %s work synchronously consumes the deadline",
    async (stage) => {
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const query = vi.spyOn(exec, "runCommandBuffered").mockImplementation(async () => {
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
      await withMockedPlatform("freebsd", async () => {
        const inspection = createFreeBsdPkgOwnershipInspection(100);
        await expect(inspection.assertUnowned("/fixture/openclaw")).rejects.toMatchObject({
          reason: "pkg-ownership-unavailable",
          message: expect.stringContaining("exhausted its shared 100 ms budget"),
        });
        await expect(inspection.assertUnowned("/another/root")).rejects.toMatchObject({
          reason: "pkg-ownership-unavailable",
          message: expect.stringContaining(
            "exhausted its shared 100 ms budget during path inspection",
          ),
        });
        // Let the test runner observe any rejection orphaned by deadline admission.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      });
      expect(query).toHaveBeenCalledTimes(1);
      expect(lookup).toHaveBeenCalledTimes(stage === "query" ? 0 : 1);
      expect(canonical).not.toHaveBeenCalled();
    },
  );

  it("caps the inspection independently of a long installation timeout", async () => {
    const query = vi
      .spyOn(exec, "runCommandBuffered")
      .mockImplementation(() => new Promise<never>(() => {}));
    vi.useFakeTimers();
    await withMockedPlatform("freebsd", async () => {
      const pending = expect(
        createFreeBsdPkgOwnershipInspection(20 * 60_000).assertUnowned("/fixture/openclaw"),
      ).rejects.toMatchObject({
        reason: "pkg-ownership-unavailable",
        message: expect.stringContaining("exhausted its shared 30000 ms budget during pkg query"),
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await pending;
    });
    expect(query).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
  });
});
