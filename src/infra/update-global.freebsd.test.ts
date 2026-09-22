import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as exec from "../process/exec.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import * as gitExec from "./git-exec.js";
import * as openclawRoot from "./openclaw-root.js";
import { createRootRunner, writePackageRoot } from "./package-update-steps.test-support.js";
import * as restartSentinel from "./restart-sentinel.js";
import { checkUpdateStatus } from "./update-check.js";
import { pkgQueryResult } from "./update-freebsd-pkg-ownership.test-support.js";
import {
  detectGlobalInstallManagerByPresence,
  cleanupGlobalRenameDirs,
  detectGlobalInstallManagerForRoot,
  resolveGlobalInstallTarget,
} from "./update-global.js";
import { resolveUpdateInstallSurface } from "./update-runner-install-surface.js";
import { createGatewayUpdateCheck } from "./update-startup.js";

afterEach(() => vi.restoreAllMocks());

describe("FreeBSD package-manager admission", () => {
  it.each(["unknown database", "exhausted budget"])(
    "ends optional cleanup after %s without another pkg probe",
    async (failure) => {
      await withTestDir({ prefix: "openclaw-pkg-cleanup-budget-" }, async (base) => {
        await fs.mkdir(path.join(base, ".openclaw-first"));
        await fs.mkdir(path.join(base, ".openclaw-second"));
        const now = Date.now();
        const clock = vi.spyOn(Date, "now").mockReturnValue(now);
        const query = vi.spyOn(exec, "runCommandBuffered").mockImplementation(async () => {
          if (failure === "exhausted budget") {
            clock.mockReturnValue(now + 30_001);
          }
          return pkgQueryResult("", failure === "unknown database" ? { code: 1 } : {});
        });
        await withMockedPlatform("freebsd", async () => {
          await expect(
            cleanupGlobalRenameDirs({ globalRoot: base, packageName: "openclaw" }),
          ).resolves.toEqual({ removed: [] });
        });
        expect(query).toHaveBeenCalledTimes(1);
        expect(await fs.readdir(base)).toHaveLength(2);
      });
    },
  );

  it("refreshes pkg ownership separately before each cleanup deletion", async () => {
    await withTestDir({ prefix: "openclaw-pkg-cleanup-refresh-" }, async (base) => {
      await fs.mkdir(path.join(base, ".openclaw-first"));
      await fs.mkdir(path.join(base, ".openclaw-second"));
      const [firstName, secondName] = await fs.readdir(base);
      const first = path.join(base, firstName!);
      const second = path.join(base, secondName!);
      const retained = path.join(second, "marker");
      await fs.writeFile(retained, "retained");
      let claimed = false;
      const remove = fs.rm.bind(fs);
      vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
        await remove(target, options);
        if (target === first) {
          claimed = true;
        }
      });
      const query = vi
        .spyOn(exec, "runCommandBuffered")
        .mockImplementation(async () => pkgQueryResult(claimed ? `${retained}\n` : ""));
      await withMockedPlatform("freebsd", async () => {
        await expect(
          cleanupGlobalRenameDirs({ globalRoot: base, packageName: "openclaw" }),
        ).resolves.toEqual({ removed: [firstName] });
      });
      expect(query).toHaveBeenCalledTimes(2);
      await expect(fs.readFile(retained, "utf8")).resolves.toBe("retained");
    });
  });

  it("skips a cleanup directory replaced during ownership inspection", async () => {
    await withTestDir({ prefix: "openclaw-pkg-cleanup-replaced-" }, async (base) => {
      const candidate = path.join(base, ".openclaw-interrupted");
      await fs.mkdir(candidate);
      vi.spyOn(exec, "runCommandBuffered").mockImplementationOnce(async () => {
        await fs.rename(candidate, path.join(base, "saved"));
        await fs.mkdir(candidate);
        await fs.writeFile(path.join(candidate, "marker"), "replacement");
        return pkgQueryResult();
      });
      await withMockedPlatform("freebsd", async () => {
        await expect(
          cleanupGlobalRenameDirs({ globalRoot: base, packageName: "openclaw" }),
        ).resolves.toEqual({ removed: [] });
      });
      await expect(fs.readFile(path.join(candidate, "marker"), "utf8")).resolves.toBe(
        "replacement",
      );
    });
  });
  it.each(["owned", "unknown", "unowned"])(
    "keeps cleanup best-effort without removing %s package files",
    async (ownership) => {
      await withTestDir({ prefix: "openclaw-pkg-cleanup-" }, async (base) => {
        const candidate = path.join(base, ".openclaw-interrupted");
        await fs.mkdir(candidate);
        const file = path.join(candidate, "marker");
        await fs.writeFile(file, "retained\n");
        vi.spyOn(exec, "runCommandBuffered").mockResolvedValue(
          pkgQueryResult(
            ownership === "owned" ? `${file}\n` : "",
            ownership === "unknown" ? { code: 1 } : {},
          ),
        );
        await withMockedPlatform("freebsd", async () => {
          await expect(
            cleanupGlobalRenameDirs({ globalRoot: base, packageName: "openclaw" }),
          ).resolves.toEqual({ removed: ownership === "unowned" ? [".openclaw-interrupted"] : [] });
        });
        if (ownership !== "unowned") {
          await expect(fs.readFile(file, "utf8")).resolves.toBe("retained\n");
        }
      });
    },
  );
  it.each(["root", "presence", "rpc surface", "status", "startup"])(
    "keeps %s discovery read-only for a pkg installation",
    async (route) => {
      await withTestDir({ prefix: "openclaw-pkg-discovery-" }, async (base) => {
        const globalRoot = path.join(base, "lib", "node_modules");
        const root = path.join(globalRoot, "openclaw");
        await writePackageRoot(root, "1.0.0");
        const runCommand = createRootRunner(globalRoot);
        const query = vi
          .spyOn(exec, "runCommandBuffered")
          .mockResolvedValue(pkgQueryResult(`${root}/package.json\n`));
        vi.spyOn(exec, "runCommandWithTimeout").mockImplementation(async (argv) => ({
          ...(await runCommand(argv, { timeoutMs: 1000 })),
          signal: null,
          killed: false,
          termination: "exit",
        }));
        vi.spyOn(gitExec, "executeGitCommand").mockResolvedValue({
          stdout: "",
          stderr: "not a git repository",
          code: 128,
          signal: null,
          killed: false,
          termination: "exit",
          timeoutMs: 1000,
        });
        vi.spyOn(openclawRoot, "resolveOpenClawPackageRoot").mockResolvedValue(root);
        vi.spyOn(restartSentinel, "readVerifiedGitUpdateReceipt").mockResolvedValue(null);
        await withMockedPlatform("freebsd", async () => {
          if (route === "root" || route === "presence") {
            await expect(
              route === "root"
                ? detectGlobalInstallManagerForRoot(runCommand, root, 1000)
                : detectGlobalInstallManagerByPresence(runCommand, 1000),
            ).resolves.toBe("npm");
          } else if (route === "rpc surface") {
            await expect(
              resolveUpdateInstallSurface({
                root,
                installKind: "package",
                runCommand: (argv, options) =>
                  runCommand(argv, { ...options, timeoutMs: options.timeoutMs ?? 1000 }),
                timeoutMs: 1000,
              }),
            ).resolves.toMatchObject({ kind: "global", mode: "npm", root });
          } else if (route === "status") {
            await expect(
              checkUpdateStatus({ root, includeRegistry: false, timeoutMs: 1000 }),
            ).resolves.toMatchObject({ root, installKind: "package", packageManager: "npm" });
          } else {
            const startup = createGatewayUpdateCheck({
              getConfig: () => ({}),
              log: { info: vi.fn() },
              isNixMode: false,
            });
            try {
              const first = await startup.initialize();
              expect(first.status).toMatchObject({
                root,
                installKind: "package",
                packageManager: "npm",
              });
              await expect(startup.initialize()).resolves.toBe(first);
            } finally {
              await startup.stop();
            }
          }
        });
        expect(query).not.toHaveBeenCalled();
      });
    },
  );

  it("checks the actual manager-selected destination before selecting its npm runtime", async () => {
    await withTestDir({ prefix: "openclaw-pkg-target-" }, async (base) => {
      const requested = path.join(base, "source");
      const globalRoot = path.join(base, "package prefix", "lib", "node_modules");
      const target = path.join(globalRoot, "openclaw");
      await writePackageRoot(requested, "1.0.0");
      await writePackageRoot(target, "1.0.0");
      const rootRunner = createRootRunner(globalRoot);
      const runCommand = vi.fn(async (...args: Parameters<typeof rootRunner>) => {
        const result = await rootRunner(...args);
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
        return result;
      });
      const query = vi
        .spyOn(exec, "runCommandBuffered")
        .mockResolvedValueOnce(pkgQueryResult())
        .mockResolvedValue(pkgQueryResult(`${target}/package.json\n`));
      await withMockedPlatform("freebsd", async () => {
        await expect(
          resolveGlobalInstallTarget({
            manager: "npm",
            pkgRoot: requested,
            runCommand,
            timeoutMs: 1000,
          }),
        ).rejects.toMatchObject({ reason: "pkg-owned-install" });
      });
      expect(runCommand.mock.calls.some(([argv]) => argv.includes("--version"))).toBe(false);
      expect(query).toHaveBeenCalledTimes(2);
    });
  });
});
