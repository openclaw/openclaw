import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveGatewayStartupTiming } from "../commands/gateway-startup-timing.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveStartupInstallStatus } from "./update-install-status.js";

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
  vi.resetAllMocks();
});

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
        pid: 1,
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
  mocks.git.mockResolvedValue({
    code: 128,
    stdout: "",
    stderr: "not a git repository",
    signal: null,
    killed: false,
    termination: "exit",
    timeoutMs: 2_500,
  });
  const { status } = await resolveStartupInstallStatus(false, new AbortController().signal);
  expect(status.installKind).toBe("package");
  expect(mocks.git).not.toHaveBeenCalled();
});
