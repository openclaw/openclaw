import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as processExec from "../process/exec.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  checkUpdateStatus as checkStatus,
  resolveUpdateInstallIdentity as resolveIdentity,
  resolveUpdateInstallKind as resolveKind,
} from "./update-check.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
const makeRoot = () => directories.make("openclaw-update-install-");

async function git(...args: string[]) {
  const result = await processExec.runCommandWithTimeout(["git", ...args], {
    timeoutMs: 5000,
  });
  expect(result.code, result.stderr).toBe(0);
  return result;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each([
  { scope: "kind", timeoutMs: undefined, discoveryMs: 5_000 },
  { scope: "identity", timeoutMs: 45_000, discoveryMs: 40_000 },
  { scope: "status", timeoutMs: 25_000, discoveryMs: 24_000 },
  { scope: "kind", timeoutMs: 50, discoveryMs: 100 },
])(
  "keeps Git ownership for slow $scope discovery ($timeoutMs ms)",
  async ({ scope, timeoutMs, discoveryMs }) => {
    const root = makeRoot();
    await git("init", root);
    const runCommand = processExec.runCommandWithTimeout;
    const observed = await git("-C", root, "rev-parse", "--show-toplevel");
    const probeStarted = createDeferredCore();
    vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      if (!argv.includes("--show-toplevel")) {
        return await runCommand(argv, options);
      }
      const allowance = typeof options === "number" ? options : options.timeoutMs;
      if (allowance === undefined) {
        throw new Error("Git discovery requires a finite allowance");
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(discoveryMs, allowance));
        probeStarted.resolve();
      });
      return allowance < discoveryMs
        ? {
            ...observed,
            code: null,
            stdout: "",
            signal: "SIGTERM",
            killed: true,
            termination: "timeout",
          }
        : observed;
    });
    vi.useFakeTimers();
    const options = { timeoutMs };
    const pending =
      scope === "kind"
        ? resolveKind(root, options)
        : (scope === "identity"
            ? resolveIdentity({ root, ...options })
            : checkStatus({ root, ...options, includeRegistry: false })
          ).then(({ installKind }) => installKind);
    const outcome =
      timeoutMs !== undefined && timeoutMs < discoveryMs
        ? expect(pending).rejects.toThrow("Git did not finish within its 0.05s budget")
        : expect(pending).resolves.toBe("git");
    await probeStarted.promise;
    await vi.advanceTimersByTimeAsync(discoveryMs);
    await outcome;
  },
);

it("classifies roots, aliases and nested packages with two Git probes", async () => {
  const base = makeRoot();
  const root = path.join(base, "repo");
  const alias = path.join(base, "alias");
  const nested = path.join(root, "node_modules", "openclaw");
  await git("init", "--separate-git-dir", path.join(base, "git-dir"), root);
  await fs.symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(nested, "package.json"), '{"name":"openclaw"}');
  const runCommand = vi.spyOn(processExec, "runCommandWithTimeout");

  await expect(resolveKind(root)).resolves.toBe("git");
  await expect(resolveKind(alias)).resolves.toBe("git");
  await expect(resolveKind(nested)).resolves.toBe("package");

  expect(runCommand).toHaveBeenCalledTimes(2);
});

it.each(["absent", "invalid-file", "invalid-directory"])(
  "does not treat a %s Git marker as a checkout",
  async (marker) => {
    const root = makeRoot();
    await fs.writeFile(path.join(root, "package.json"), '{"name":"openclaw"}');
    if (marker === "invalid-file") {
      await fs.writeFile(path.join(root, ".git"), "not a Git directory pointer\n");
    } else if (marker === "invalid-directory") {
      await fs.mkdir(path.join(root, ".git"));
    }

    const runCommand = vi.spyOn(processExec, "runCommandWithTimeout");
    await expect(resolveKind(root)).resolves.toBe("package");
    expect(runCommand).toHaveBeenCalledTimes(marker === "absent" ? 0 : 1);
  },
);

it("honors GIT_DIR and GIT_WORK_TREE without a marker", async () => {
  const base = makeRoot();
  const root = path.join(base, "repo");
  const gitDir = path.join(base, "git-dir");
  await fs.mkdir(root);
  await git("init", "--bare", gitDir);

  await withEnvAsync({ GIT_DIR: gitDir, GIT_WORK_TREE: root }, async () => {
    await expect(resolveKind(root)).resolves.toBe("git");
  });
});

it("leaves unavailable and undiscovered roots unclassified", async () => {
  const base = makeRoot();
  await expect(resolveKind(path.join(base, "missing"))).resolves.toBe("unknown");
  await expect(resolveKind(null)).resolves.toBe("unknown");
});
