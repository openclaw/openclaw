import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../../scripts/lib/package-dist-inventory.ts";
import type { PackageUpdateTransaction } from "../../infra/package-update-steps.js";
import {
  createNpmTarget,
  writePackageRoot,
} from "../../infra/package-update-steps.test-support.js";
import { runPackagePostInstallVerification } from "../../infra/package-update-verification-step.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import {
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  writeUpdatePostInstallDoctorResult,
  type UpdatePostInstallDoctorResult,
} from "../../infra/update-doctor-result.js";
import { DEFAULT_UPDATE_STEP_TIMEOUT_MS } from "../../infra/update-run-timeouts.js";
import * as gitRunner from "../../infra/update-runner-git.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import * as processRunner from "../../process/exec.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import * as shared from "./shared.js";
import { updateGitInstall } from "./update-command-git.js";
import * as packageUpdate from "./update-command-package.js";
import { runPackageInstallUpdate, stagePackageInstallUpdate } from "./update-command-package.js";
import { resolveUpdateResultNextAction } from "./update-recovery-guidance.js";

afterEach(() => vi.restoreAllMocks());

async function createPackageInstallFixture(
  base: string,
  candidateVersion = "1.0.0",
  buildId?: string,
) {
  const globalRoot = path.join(base, "prefix", "lib", "node_modules");
  const target = createNpmTarget(globalRoot);
  const root = path.join(globalRoot, "openclaw");
  await writePackageRoot(root, "1.0.0");
  if (buildId) {
    await fs.writeFile(path.join(root, "dist", "build-info.json"), JSON.stringify({ buildId }));
    await writePackageDistInventory(root);
  }
  const launcher = path.join(base, "prefix", "bin", "openclaw");
  await fs.mkdir(path.dirname(launcher), { recursive: true });
  await fs.writeFile(launcher, "previous launcher\n");
  const installedPrefixes: string[] = [];
  vi.spyOn(processRunner, "runCommandWithTimeout").mockImplementation(async (argv) => {
    let stdout = "";
    if (argv.join(" ") === "npm --version") {
      stdout = "12.0.0\n";
    } else if (argv.join(" ") === "npm root -g") {
      stdout = `${globalRoot}\n`;
    } else if (argv.includes("--prefix") && (argv.includes("install") || argv.includes("i"))) {
      const prefix = argv[argv.indexOf("--prefix") + 1];
      if (!prefix) {
        throw new Error("Missing actual staged prefix");
      }
      installedPrefixes.push(prefix);
      await writePackageRoot(
        path.join(prefix, "lib", "node_modules", "openclaw"),
        candidateVersion,
      );
      if (buildId) {
        const stagedRoot = path.join(prefix, "lib", "node_modules", "openclaw");
        await fs.writeFile(
          path.join(stagedRoot, "dist", "build-info.json"),
          JSON.stringify({ buildId }),
        );
        await writePackageDistInventory(stagedRoot);
      }
      await fs.mkdir(path.join(prefix, "bin"), { recursive: true });
      await fs.writeFile(path.join(prefix, "bin", "openclaw"), "candidate launcher\n");
    } else {
      throw new Error(`Unexpected package command: ${argv.join(" ")}`);
    }
    return { stdout, stderr: "", code: 0, signal: null, killed: false, termination: "exit" };
  });
  const expectOriginalInstallation = async () => {
    expect(await fs.readFile(launcher, "utf8")).toBe("previous launcher\n");
    expect(JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).version).toBe(
      "1.0.0",
    );
  };
  return { root, target, launcher, installedPrefixes, expectOriginalInstallation };
}

it.each(["guidance", "staging"])(
  "carries the owner's permission retry outcome through %s",
  async (consumer) => {
    await withTestDir({ prefix: "update-permission-retry-" }, async (base) => {
      const { root, target, expectOriginalInstallation } = await createPackageInstallFixture(base);
      const globalRoot = path.dirname(root);
      let attempts = 0;
      vi.mocked(processRunner.runCommandWithTimeout).mockImplementation(async (argv) => {
        expect(argv.slice(0, 3)).toEqual(["npm", "i", "-g"]);
        attempts++;
        expect(argv.includes("--omit=optional")).toBe(attempts === 2);
        return {
          stdout: "",
          stderr:
            attempts === 1
              ? "npm error code ERESOLVE\nInitial dependency resolution failed"
              : `npm error code EACCES\nnpm error syscall rename\nnpm error path ${root}\nnpm error EACCES: permission denied, rename '${root}'`,
          code: attempts === 1 ? 1 : 243,
          signal: null,
          killed: false,
          termination: "exit",
        };
      });
      const env = {
        OPENCLAW_STATE_DIR: path.join(base, "state"),
        OPENCLAW_CONFIG_PATH: path.join(base, "openclaw.json"),
      };
      const params = {
        root,
        installKind: "package" as const,
        tag: "2.0.0",
        timeoutMs: 1000,
        workTimeoutMs: null,
        startedAt: Date.now(),
        progress: {},
        installEnv: env,
        managedServiceEnv: env,
        installTarget: target,
      };
      const permissionFacts = [
        {
          check: "package-install",
          code: "global-install-permission-denied",
          message: "Package update cannot write [redacted-path]",
        },
        ...[
          "npm error code EACCES",
          "npm error syscall rename",
          "npm error path [redacted-path]",
          "npm error EACCES: permission denied, rename [redacted-path]",
        ].map((message) => ({ check: "npm", code: "EACCES", message })),
      ];
      if (consumer === "staging") {
        await expect(stagePackageInstallUpdate(params)).rejects.toMatchObject({
          reason: "global-install-permission-denied",
          message: expect.stringContaining(globalRoot),
          failureFacts: permissionFacts,
        });
      } else {
        const result = await runPackageInstallUpdate({
          ...params,
          validateCandidate: vi.fn(),
          beforeActivate: vi.fn(),
          onTransaction: vi.fn(),
        });
        const nextAction = resolveUpdateResultNextAction({ result, env });
        expect(nextAction).toContain(globalRoot);
        expect(nextAction).toContain("rerun `openclaw update`");
        expect(nextAction).not.toContain("Initial dependency resolution failed");
        expect(result).toMatchObject({
          reason: "global-install-permission-denied",
          failedStep: { name: "package-install-omit-optional", failureFacts: permissionFacts },
          recovery: { serviceRestartSafe: true, version: "1.0.0" },
        });
      }
      expect(attempts).toBe(2);
      for (const [argv, options] of vi.mocked(processRunner.runCommandWithTimeout).mock.calls) {
        expect(options, argv.join(" ")).toMatchObject({ timeoutMs: undefined });
      }
      expect(await fs.readdir(globalRoot)).toEqual(["openclaw"]);
      await expectOriginalInstallation();
    });
  },
);

it.each([
  "1.0.0",
  "file:/owned/candidate.tgz",
  "https://example.invalid/candidate.tgz",
  "openclaw@file:/owned/candidate",
  "openclaw@1.0.0",
])(
  "honors the explicit package artifact without changing registry no-op semantics: %s",
  async (tag) => {
    await withTestDir({ prefix: "update-exact-artifact-" }, async (base) => {
      const { root, target, launcher, expectOriginalInstallation } =
        await createPackageInstallFixture(base);
      const stopped = new Error("pause at owned pre-activation boundary");
      const validateCandidate = vi.fn(async (candidate: string) => {
        expect(candidate).not.toBe(root);
        expect(await fs.readFile(launcher, "utf8")).toBe("previous launcher\n");
        return [];
      });
      const beforeActivate = vi.fn(async () => {
        throw stopped;
      });
      const onTransaction = vi.fn();
      const update = runPackageInstallUpdate({
        root,
        installKind: "package",
        tag: tag.startsWith("openclaw@") ? "latest" : tag,
        timeoutMs: 1000,
        startedAt: Date.now(),
        progress: {},
        installEnv: tag.startsWith("openclaw@") ? { OPENCLAW_UPDATE_PACKAGE_SPEC: tag } : {},
        installTarget: target,
        validateCandidate,
        beforeActivate,
        onTransaction,
      });
      if (tag === "1.0.0" || tag === "openclaw@1.0.0") {
        expect(await update).toMatchObject({ status: "skipped", reason: "already-current" });
        expect(validateCandidate).not.toHaveBeenCalled();
        expect(beforeActivate).not.toHaveBeenCalled();
      } else {
        await expect(update).rejects.toBe(stopped);
        expect(validateCandidate).toHaveBeenCalledOnce();
        expect(beforeActivate).toHaveBeenCalledOnce();
      }
      expect(onTransaction).not.toHaveBeenCalled();
      await expectOriginalInstallation();
    });
  },
);

it.each(["package", "git"] as const)(
  "preserves matching explicit artifact behavior for an existing %s install",
  async (installKind) => {
    await withTestDir({ prefix: "update-matching-artifact-" }, async (base) => {
      const { root, target, expectOriginalInstallation } = await createPackageInstallFixture(
        base,
        "1.0.0",
        "same-build",
      );
      const validateCandidate = vi.fn(async () => [
        { name: "canary", command: "canary", cwd: base, durationMs: 0, exitCode: 1 },
      ]);
      const beforeActivate = vi.fn(async () => {});

      const result = await runPackageInstallUpdate({
        root,
        installKind,
        tag: "https://example.invalid/candidate.tgz",
        timeoutMs: 1000,
        startedAt: Date.now(),
        progress: {},
        installEnv: {},
        installTarget: target,
        validateCandidate,
        beforeActivate,
        onTransaction: vi.fn(),
      });
      if (installKind === "package") {
        expect(result).toMatchObject({ status: "skipped", reason: "already-current" });
        expect(validateCandidate).not.toHaveBeenCalled();
      } else {
        expect(result).toMatchObject({ status: "error", reason: "unexpected-error" });
        expect(result.steps).toContainEqual(
          expect.objectContaining({ name: "canary", exitCode: 1 }),
        );
        expect(validateCandidate).toHaveBeenCalledOnce();
      }
      expect(beforeActivate).not.toHaveBeenCalled();
      await expectOriginalInstallation();
    });
  },
);

it("admits a matching staged artifact without retaining or replacing the running package", async () => {
  await withTestDir({ prefix: "update-admitted-noop-" }, async (base) => {
    const { root, target, installedPrefixes, expectOriginalInstallation } =
      await createPackageInstallFixture(base, "1.0.0", "same-build");
    const params = {
      root,
      installKind: "package" as const,
      tag: "https://example.invalid/candidate.tgz",
      timeoutMs: 1000,
      startedAt: Date.now(),
      progress: {},
      installEnv: {},
      installTarget: target,
    };
    const staged = await stagePackageInstallUpdate({ ...params, pauseBeforeVerification: true });
    const validateCandidate = vi.fn(async () => []);
    const beforeActivate = vi.fn(async () => {});
    const onTransaction = vi.fn();
    try {
      const result = await staged.run({
        ...params,
        validateCandidate,
        beforeActivate,
        onTransaction,
      });
      expect(result).toMatchObject({
        status: "skipped",
        reason: "already-current",
        after: { version: "1.0.0" },
      });
      expect(validateCandidate).not.toHaveBeenCalled();
      expect(beforeActivate).not.toHaveBeenCalled();
      expect(onTransaction).not.toHaveBeenCalled();
      await expectOriginalInstallation();
      expect(installedPrefixes).toHaveLength(1);
      for (const prefix of installedPrefixes) {
        await expect(fs.stat(prefix)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await staged.close();
    }
  });
});

it.each(
  [
    { name: "new version", candidateVersion: "2.0.0", tag: "2.0.0", buildId: undefined },
    {
      name: "matching explicit artifact",
      candidateVersion: "1.0.0",
      tag: "https://example.invalid/candidate.tgz",
      buildId: "same-build",
    },
  ].flatMap(({ name, candidateVersion, tag, buildId }) =>
    (["run", "close"] as const).map((action) => ({ name, candidateVersion, tag, buildId, action })),
  ),
)(
  "retains the exact $name staged runtime without replacing the active installation before $action",
  async ({ action, candidateVersion, tag, buildId }) => {
    await withTestDir({ prefix: "update-retained-stage-" }, async (base) => {
      const { root, target, installedPrefixes, expectOriginalInstallation } =
        await createPackageInstallFixture(base, candidateVersion, buildId);
      const params = {
        root,
        installKind: "package" as const,
        tag,
        timeoutMs: 1000,
        startedAt: Date.now(),
        progress: {},
        installEnv: {},
        installTarget: target,
      };
      const staged = await stagePackageInstallUpdate(params);
      expect(installedPrefixes).toHaveLength(1);
      expect(staged.root).not.toBe(root);
      expect(
        JSON.parse(await fs.readFile(path.join(staged.root, "package.json"), "utf8")).version,
      ).toBe(candidateVersion);
      await expectOriginalInstallation();
      if (action === "run") {
        const runtimeIdentity = await fs.stat(path.join(staged.root, "dist", "index.js"));
        const stopped = new Error("stop before activating the initialized runtime");
        const validateCandidate = vi.fn(async (candidate: string) => {
          expect(candidate).toBe(staged.root);
          expect(await fs.stat(path.join(candidate, "dist", "index.js"))).toMatchObject({
            ino: runtimeIdentity.ino,
            dev: runtimeIdentity.dev,
          });
          await expectOriginalInstallation();
          return [];
        });
        const beforeActivate = vi.fn(async () => {
          throw stopped;
        });
        const onTransaction = vi.fn();
        await expect(
          staged.run({ ...params, validateCandidate, beforeActivate, onTransaction }),
        ).rejects.toBe(stopped);
        expect(validateCandidate).toHaveBeenCalledOnce();
        expect(beforeActivate).toHaveBeenCalledOnce();
        expect(onTransaction).not.toHaveBeenCalled();
      } else {
        await expect(staged.close()).resolves.toBeUndefined();
      }
      expect(installedPrefixes).toHaveLength(1);
      await expectOriginalInstallation();
      for (const prefix of installedPrefixes) {
        await expect(fs.stat(prefix)).rejects.toMatchObject({ code: "ENOENT" });
      }
    });
  },
);

it.each([
  { policy: "unbounded", workTimeoutMs: null, expectedTimeoutMs: undefined },
  { policy: "explicit", workTimeoutMs: 2000, expectedTimeoutMs: 2000 },
  { policy: "legacy", workTimeoutMs: undefined, expectedTimeoutMs: 1000 },
])(
  "runs staged install and Doctor with the $policy work budget",
  async ({ workTimeoutMs, expectedTimeoutMs }) => {
    await withTestDir({ prefix: "update-staged-doctor-" }, async (base) => {
      const globalRoot = path.join(base, "prefix", "lib", "node_modules");
      const root = path.join(globalRoot, "openclaw");
      const entryPath = path.join(root, "dist", "index.js");
      await writePackageRoot(root, "2026.4.21");
      const commands = vi
        .spyOn(processRunner, "runCommandWithTimeout")
        .mockImplementation(async (argv, options) => {
          if (argv[0] === "npm" && argv[1] === "i") {
            const prefix = argv[argv.indexOf("--prefix") + 1];
            if (!argv.includes("--prefix") || !prefix) {
              throw new Error("Missing actual staged prefix");
            }
            await writePackageRoot(
              path.join(prefix, "lib", "node_modules", "openclaw"),
              "2026.5.14",
            );
          } else if (argv[2] === "doctor") {
            expect(argv.slice(1)).toEqual([entryPath, "doctor", "--non-interactive", "--fix"]);
            expect(options).toMatchObject({
              cwd: root,
              env: {
                OPENCLAW_SERVICE_REPAIR_POLICY: "external",
                OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.5.14",
              },
            });
            expect(
              JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")),
            ).toMatchObject({ version: "2026.5.14" });
          } else {
            throw new Error(`Unexpected package command: ${argv.join(" ")}`);
          }
          return {
            stdout: "",
            stderr: "",
            code: 0,
            signal: null,
            killed: false,
            termination: "exit",
          };
        });
      let transaction: PackageUpdateTransaction | undefined;
      try {
        const result = await runPackageInstallUpdate({
          root,
          installKind: "package",
          tag: "2026.5.14",
          installSpec: "openclaw@2026.5.14",
          installTarget: createNpmTarget(globalRoot),
          installEnv: {},
          managedServiceEnv: {
            OPENCLAW_STATE_DIR: path.join(base, "state"),
            OPENCLAW_CONFIG_PATH: path.join(base, "openclaw.json"),
          },
          timeoutMs: 1000,
          workTimeoutMs,
          startedAt: Date.now(),
          progress: {},
          validateCandidate: async () => [],
          beforeActivate: async () => {},
          onTransaction: (retained) => {
            transaction = retained;
          },
        });
        expect(result).toMatchObject({ status: "ok", root, after: { version: "2026.5.14" } });
        expect(commands.mock.calls.filter(([argv]) => argv[2] === "doctor")).toHaveLength(1);
        for (const [argv, options] of commands.mock.calls) {
          expect(options, argv.join(" ")).toMatchObject({ timeoutMs: expectedTimeoutMs });
        }
      } finally {
        if (transaction) {
          const assertCurrent = () => {};
          // This test never starts a service; restore before retiring the retained package backup.
          const rollback = await transaction.rollback(assertCurrent);
          const retirement = await transaction.complete(
            { activationVerified: false },
            assertCurrent,
          );
          expect(rollback.exitCode).toBe(0);
          expect(retirement).toBeUndefined();
        }
      }
    });
  },
);

it.each(
  (["package", "package-to-git"] as const).flatMap((method) =>
    (["include-ownership", "requester-revoked"] as const).map((reason) => ({ method, reason })),
  ),
)(
  "retains the $reason Doctor receipt when $method verification throws after settlement",
  async ({ method, reason }) => {
    const expectedDoctorTimeoutMs =
      method === "package-to-git" && reason === "include-ownership" ? undefined : 1000;
    await withTestDir({ prefix: "update-doctor-receipt-" }, async (base) => {
      const { root, target, expectOriginalInstallation } = await createPackageInstallFixture(
        base,
        "2.0.0",
      );
      vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(base);
      const env = {
        OPENCLAW_STATE_DIR: path.join(base, "state"),
        OPENCLAW_CONFIG_PATH: path.join(base, "openclaw.json"),
      };
      await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}\n");
      const receipt: UpdatePostInstallDoctorResult = {
        status: "error",
        configChanges: [{ kind: "migration", message: "Moved model allowlist." }],
        configWriteRefusal: { reason, message: "Config writer refused.", keys: ["agents"] },
        failureFacts: [{ check: "config", code: reason, affectedKey: "agents" }],
        warnings: ["Review the migrated model allowlist."],
      };
      const installCommand = vi.mocked(processRunner.runCommandWithTimeout).getMockImplementation();
      assert(installCommand);
      let resultPath: string | undefined;
      vi.mocked(processRunner.runCommandWithTimeout).mockImplementation(async (argv, options) => {
        if (argv[2] !== "doctor") {
          return await installCommand(argv, options);
        }
        assert(typeof options === "object");
        expect(options).toMatchObject({ timeoutMs: expectedDoctorTimeoutMs });
        resultPath = options.env?.[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV];
        assert(resultPath);
        await writeUpdatePostInstallDoctorResult({ resultPath, result: receipt });
        throw new Error("Doctor transport failed after the child settled.");
      });

      let transaction: PackageUpdateTransaction | undefined;
      try {
        let result: UpdateRunResult;
        if (method === "package") {
          result = await runPackageInstallUpdate({
            root,
            installKind: "package",
            tag: "2.0.0",
            installTarget: target,
            installEnv: env,
            managedServiceEnv: env,
            timeoutMs: 1000,
            startedAt: Date.now(),
            progress: {},
            validateCandidate: async () => [],
            beforeActivate: async () => {},
            onTransaction: (retained) => {
              transaction = retained;
            },
          });
        } else {
          const gitRoot = path.join(base, "checkout");
          await writePackageRoot(gitRoot, "2.0.0");
          vi.spyOn(shared, "resolveGitInstallDir").mockReturnValue(gitRoot);
          vi.spyOn(shared, "resolveGlobalManager").mockResolvedValue("npm");
          vi.spyOn(shared, "ensureGitCheckout").mockResolvedValue({
            checkoutDir: gitRoot,
            step: null,
          });
          vi.spyOn(gitRunner, "updateGitCheckout").mockImplementation(async ({ opts }) => {
            assert(opts.prepareGitExposure);
            await opts.prepareGitExposure(gitRoot, "a".repeat(40), env);
            return { status: "ok", mode: "git", root: gitRoot, steps: [], durationMs: 0 };
          });
          vi.spyOn(packageUpdate, "prepareGitPackageExposure").mockImplementation(
            async (params) => {
              assert(params.postVerifyStep);
              expect(params).toMatchObject({
                timeoutMs: expectedDoctorTimeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS,
                workTimeoutMs: expectedDoctorTimeoutMs ?? null,
              });
              const verify = params.postVerifyStep;
              return {
                activate: async () => {
                  const failedStep = await runPackagePostInstallVerification(gitRoot, verify);
                  return {
                    steps: [failedStep],
                    failedStep,
                    activePackageRoot: root,
                    afterVersion: "2.0.0",
                    recovery: { serviceRestartSafe: false, reason: "state-migration-started" },
                  };
                },
                cancel: async () => ({
                  steps: [],
                  recovery: { serviceRestartSafe: true, version: "1.0.0" },
                }),
              };
            },
          );
          result = await updateGitInstall({
            root,
            switchToGit: true,
            installKind: "package",
            timeoutMs: expectedDoctorTimeoutMs,
            startedAt: Date.now(),
            progress: {},
            channel: "dev",
            inspectGitTarget: async () => {},
            beforeGitMutation: async () => {},
            validateCandidate: async () => {},
            getManagedServiceEnv: () => env,
            getSnapshotSource: async () => ({ config: {}, env }),
            jsonMode: true,
          });
        }
        expect(result).toMatchObject({
          status: "error",
          reason: reason === "requester-revoked" ? reason : "repair-requires-config-change",
          failedStep: {
            name: "openclaw doctor",
            exitCode: 1,
            configChanges: receipt.configChanges,
            configWriteRefusal: receipt.configWriteRefusal,
            failureFacts: expect.arrayContaining([
              ...(receipt.failureFacts ?? []),
              expect.objectContaining({
                check: "openclaw doctor",
                code: "Error",
                message: "Doctor transport failed after the child settled.",
              }),
            ]),
            warnings: receipt.warnings,
          },
        });
        expect(result.failedStep?.advisory).toBeUndefined();
        expect(result.failedStep?.stderrTail).toContain(
          "Doctor transport failed after the child settled.",
        );
        expect(
          result.failedStep?.stderrTail?.match(
            /Doctor transport failed after the child settled\./gu,
          ),
        ).toHaveLength(1);
        expect(result.steps.filter((step) => step.name === "openclaw doctor")).toEqual([
          result.failedStep,
        ]);
        assert(resultPath, "Doctor must write its receipt through the production callback");
        await expect(fs.access(resultPath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        if (transaction) {
          const rollback = await transaction.rollback(() => {});
          expect(rollback.exitCode).toBe(0);
          await transaction.complete({ activationVerified: false }, () => {});
        }
      }
      await expectOriginalInstallation();
    });
  },
);
