import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveGatewayStartupTiming } from "../commands/gateway-startup-timing.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  prepareStartupUpdateInstall,
  resolveStartupInstallStatus,
} from "./update-install-status.js";

const mocks = vi.hoisted(() => ({
  root: vi.fn(),
  git: vi.fn<typeof import("./git-exec.js").executeGitCommand>(),
}));
vi.mock("./openclaw-root.js", () => ({ resolveOpenClawPackageRoot: mocks.root }));
vi.mock("./restart-sentinel.js", () => ({ readVerifiedGitUpdateReceipt: async () => null }));
vi.mock("./git-exec.js", async (original) => ({
  ...(await original<typeof import("./git-exec.js")>()),
  executeGitCommand: mocks.git,
}));
vi.mock("./update-global.js", () => ({ detectGlobalInstallManagerForRoot: async () => "npm" }));

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

it.each(["root", "current", "release"] as const)(
  "initializes an externally managed immutable %s without taking update ownership",
  async (spelling) => {
    const root = await fs.realpath(dirs.make("openclaw-update-external-immutable-"));
    const sha = "a".repeat(40);
    const release = path.join(root, "releases", sha);
    await fs.mkdir(release, { recursive: true, mode: 0o755 });
    await fs.mkdir(path.join(release, ".git"));
    await fs.symlink(`releases/${sha}`, path.join(root, "current"));
    const lstat = fsSync.lstatSync;
    vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
      const stat = lstat(...args);
      // Synthetic layout retains its inode/mode checks under an unprivileged test runner.
      if (stat && String(args[0]).startsWith(root)) {
        Object.defineProperty(stat, "uid", { value: typeof stat.uid === "bigint" ? 0n : 0 });
      }
      return stat;
    });
    mocks.root.mockResolvedValue(
      spelling === "root" ? root : spelling === "current" ? path.join(root, "current") : release,
    );
    const signal = new AbortController().signal;

    const prepared = await prepareStartupUpdateInstall(
      () => resolveStartupInstallStatus(false, signal),
      "dev",
      signal,
    );

    expect(prepared.installStatus.status).toMatchObject({
      installKind: "host",
      installOwner: { owner: "immutable-deployer" },
      packageManager: "unknown",
    });
    expect(prepared.installStatus.status.error).toBeUndefined();
    expect(prepared.readOnlySchedule).toEqual({ channel: "dev", autoEnabled: false });
    expect(mocks.git).not.toHaveBeenCalled();
    expect((await fs.readdir(root)).toSorted()).toEqual(["current", "releases"]);
    expect(await fs.readlink(path.join(root, "current"))).toBe(`releases/${sha}`);
  },
);

it.each(["recover", "exhaust", "abort"] as const)(
  "settles a startup Git probe after a timeout (%s)",
  async (outcome) => {
    const root = dirs.make("openclaw-update-init-");
    await fs.mkdir(path.join(root, ".git"));
    await fs.writeFile(
      path.join(root, "package.json"),
      '{"name":"openclaw","packageManager":"pnpm@10.0.0"}',
    );
    mocks.root.mockResolvedValue(root);
    const firstProbe = createDeferredCore();
    let attempts = 0;
    mocks.git.mockImplementation(async (_root, args, options) => {
      const ownership = args.includes("--show-toplevel");
      if (ownership) {
        attempts++;
      }
      const timeout = ownership && (attempts === 1 || outcome === "exhaust");
      if (timeout) {
        firstProbe.resolve();
      }
      return {
        code: timeout ? null : 0,
        stdout: ownership ? root : "",
        stderr: "",
        signal: timeout ? "SIGTERM" : null,
        killed: timeout,
        termination: timeout ? "timeout" : "exit",
        timeoutMs: options?.timeoutMs ?? 0,
      };
    });
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = resolveStartupInstallStatus(false, controller.signal);
    const settled = pending.catch((error: unknown) => error);
    await firstProbe.promise;
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    if (outcome === "abort") {
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(attempts).toBe(1);
    } else {
      await vi.advanceTimersByTimeAsync(1_000);
      const { status } = await pending;
      expect(attempts).toBe(2);
      if (outcome === "recover") {
        expect(status.installKind).toBe("git");
        expect(status.error).toBeUndefined();
      } else {
        expect(status).toMatchObject({
          installKind: "unknown",
          error: { status: "failed", timeoutMs: resolveGatewayStartupTiming().deadlineMs },
        });
      }
    }
    await settled;
    expect(mocks.git.mock.calls[0]?.[2]?.timeoutMs).toBe(resolveGatewayStartupTiming().deadlineMs);
  },
);

it("initializes an immutable package directory without invoking Git", async () => {
  const root = dirs.make("openclaw-update-package-");
  await fs.writeFile(path.join(root, "package.json"), '{"name":"openclaw"}');
  mocks.root.mockResolvedValue(root);
  const { status } = await resolveStartupInstallStatus(false, new AbortController().signal);
  expect(status.installKind).toBe("package");
  expect(mocks.git).not.toHaveBeenCalled();
});
