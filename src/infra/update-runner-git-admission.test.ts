import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import * as diskSpace from "./disk-space.js";
import { collectNestedErrorCandidates } from "./error-graph-internal.js";
import { renderUpdateRunReport, updateRunReportInputFromResult } from "./update-run-report.js";
import { buildUpdateCommandRunner } from "./update-runner-command.js";
import { createGitAdmissionFixture } from "./update-runner-git-admission.test-support.js";
import { withGitTargetInspectionRoot } from "./update-runner-git-target.js";
import { updateGitCheckout } from "./update-runner-git.js";
import type {
  CommandRunner,
  UpdateRunnerOptions,
  UpdateStepProgress,
} from "./update-runner-types.js";

function snapshotTree(root: string): string[] {
  return fs
    .readdirSync(root, { recursive: true, encoding: "utf8" })
    .toSorted()
    .flatMap((name) => {
      const fullPath = path.join(root, name);
      const stat = fs.lstatSync(fullPath);
      return stat.isFile()
        ? [
            `${name} ${stat.size} ${stat.mtimeMs} ${createHash("sha256").update(fs.readFileSync(fullPath)).digest("hex")}`,
          ]
        : stat.isSymbolicLink()
          ? [`${name} -> ${fs.readlinkSync(fullPath)}`]
          : [];
    });
}

describe("Git database admission", () => {
  it.each(
    (["sha1", "sha256"] as const).flatMap((objectFormat) =>
      [false, true].map((cached) => ({ objectFormat, cached })),
    ),
  )(
    "fetches a detached commit only when missing ($objectFormat, cached=$cached)",
    async ({ objectFormat, cached }) => {
      const state = createGitAdmissionFixture(false, false, false, objectFormat);
      if (cached) {
        state.git(state.install, "fetch", "upstream.with.dots");
      }
      state.commit("2026.7.3", 15);
      const result = await state.run({
        channel: "dev",
        devTarget: { mode: "detached", ref: state.target },
      });

      expect(result.status, JSON.stringify(result)).toBe("ok");
      expect(state.git(state.install, "rev-parse", "HEAD")).toBe(state.target);
      expect(state.calls.some((argv) => argv.includes("fetch"))).toBe(!cached);
    },
  );

  it.each(["unsupported", "timeout-zero", "signal-zero"] as const)(
    "settles a cached-target probe before remote discovery (%s)",
    async (failure) => {
      const state = createGitAdmissionFixture();
      state.git(state.install, "fetch", "upstream.with.dots");
      let fetched = false;
      const command: CommandRunner = (argv, options) => {
        fetched ||= argv.includes("fetch");
        if (
          argv.includes("--batch-check=%(objectname) %(objecttype)") &&
          options.input === `${state.target}\n`
        ) {
          return Promise.resolve({
            code: failure === "unsupported" ? 129 : 0,
            stdout: `${state.target} commit\n`,
            stderr: "cache probe incomplete",
            ...(failure === "unsupported"
              ? {}
              : {
                  killed: true,
                  signal: "SIGTERM" as const,
                  termination:
                    failure === "signal-zero" ? ("signal" as const) : ("timeout" as const),
                }),
          });
        }
        return state.runCommand(argv, options);
      };
      const result = await state.run(
        { channel: "dev", devTarget: { mode: "detached", ref: state.target } },
        command,
      );
      expect(result.status).toBe(failure === "signal-zero" ? "error" : "ok");
      expect(fetched).toBe(failure !== "signal-zero");
      expect(state.git(state.install, "rev-parse", "HEAD")).toBe(
        failure === "signal-zero"
          ? state.git(state.source, "rev-parse", "v2026.7.1")
          : state.target,
      );
    },
  );

  it.each(["sha1", "sha256"] as const)(
    "snapshots linked-worktree refs and validates their objects without source writes (%s)",
    async (objectFormat) => {
      const state = createGitAdmissionFixture(false, false, false, objectFormat);
      const linked = path.join(state.root, "linked");
      state.git(state.install, "worktree", "add", "-b", "inspection-source", linked);
      state.git(
        linked,
        "-c",
        "user.name=Update fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "tag.gpgSign=false",
        "tag",
        "-a",
        "retained-tag",
        "-m",
        "retained annotated tag",
      );
      state.git(linked, "config", "init.defaultRefFormat", "reftable");
      const head = state.git(linked, "rev-parse", "HEAD");
      const tag = state.git(linked, "rev-parse", "refs/tags/retained-tag");
      const refs = state.git(linked, "for-each-ref", "--format=%(objectname) %(refname)");
      const before = snapshotTree(state.install);
      const inspect = (runCommand = state.runCommand) =>
        withGitTargetInspectionRoot(
          { root: linked, runCommand, timeoutMs: 15_000, onWarning: () => {} },
          async (root) => {
            expect(state.git(root, "for-each-ref", "--format=%(objectname) %(refname)")).toBe(refs);
            expect(state.git(root, "symbolic-ref", "HEAD")).toBe("refs/heads/inspection-source");
            expect(state.git(root, "rev-parse", "HEAD")).toBe(head);
            expect(state.git(root, "rev-parse", "refs/tags/retained-tag")).toBe(tag);
            expect(state.git(root, "rev-parse", "refs/tags/retained-tag^{}")).toBe(head);
          },
        );
      await inspect();
      expect(snapshotTree(state.install)).toEqual(before);

      if (objectFormat === "sha1") {
        for (const failure of ["truncated", "signaled"] as const) {
          const interrupted: CommandRunner = async (argv, options) => {
            const result = await state.runCommand(argv, options);
            return argv.includes("--batch-check=%(objectname) %(objecttype)")
              ? failure === "truncated"
                ? { ...result, stdout: result.stdout.slice(0, -8) }
                : { ...result, termination: "signal", killed: true }
              : result;
          };
          await expect(inspect(interrupted)).rejects.toThrow("Git target inspection");
          expect(snapshotTree(state.install)).toEqual(before);
        }
      }

      const malformed = path.join(state.root, "malformed-commit");
      fs.writeFileSync(malformed, "malformed commit\n");
      const invalidObjects = [
        "f".repeat(head.length),
        state.git(linked, "rev-parse", "HEAD:package.json"),
        state.git(linked, "hash-object", "--literally", "-w", "-t", "commit", malformed),
      ];
      const invalidRef = path.join(state.install, ".git", "refs", "heads", "invalid");
      for (const oid of invalidObjects) {
        fs.writeFileSync(invalidRef, `${oid}\n`);
        const invalidSource = snapshotTree(state.install);
        await expect(inspect()).rejects.toThrow("Git target inspection");
        expect(snapshotTree(state.install)).toEqual(invalidSource);
      }
    },
  );

  it.each([
    { channel: "stable", publish: true, downgrade: false, shallow: false },
    { channel: "dev", publish: false, downgrade: true, shallow: false },
    { channel: "dev", publish: false, downgrade: false, shallow: true },
  ] as const)(
    "activates a partial clone without upstream access after admission ($channel, publish=$publish, downgrade=$downgrade, shallow=$shallow)",
    async ({ channel, publish, downgrade, shallow }) => {
      const state = createGitAdmissionFixture(false, true, shallow);
      const published = path.join(state.root, "published");
      const target = downgrade
        ? state.git(state.source, "rev-parse", "v2026.7.2-beta.1")
        : state.target;
      if (downgrade) {
        state.git(state.install, "fetch", "upstream.with.dots");
        state.git(state.install, "checkout", "--detach", state.target);
        const availability = await state.runCommand(
          [
            "git",
            "-C",
            state.install,
            "--no-lazy-fetch",
            "cat-file",
            "-e",
            `${target}:package.json`,
          ],
          { cwd: state.install, timeoutMs: 15_000 },
        );
        expect(availability.code).not.toBe(0);
      }
      const admission = vi.fn(async () => {
        // Activation must consume staged objects, even if upstream goes offline.
        fs.renameSync(state.source, `${state.source}.offline`);
      });
      let stagedRoot: string | undefined;
      const result = await state.run({
        channel,
        ...(downgrade ? { devTarget: { mode: "detached" as const, ref: target } } : {}),
        beforeGitMutation: admission,
        ...(publish
          ? {
              gitArtifactStorageRoot: state.root,
              validateCandidate: async (candidateRoot) => {
                stagedRoot = candidateRoot;
                const artifacts =
                  process.platform === "win32"
                    ? path.win32.join(process.env.SystemDrive ?? "C:", "ocu")
                    : path.join(fs.realpathSync(state.root), ".artifacts");
                expect(fs.realpathSync(candidateRoot).startsWith(artifacts + path.sep)).toBe(true);
                expect(fs.statSync(candidateRoot).dev).toBe(fs.statSync(artifacts).dev);
              },
              publishGitCheckout: async () => {
                fs.renameSync(state.install, published);
                assert(stagedRoot);
                expect(fs.statSync(path.join(stagedRoot, "dist", "entry.js")).isFile()).toBe(true);
                return published;
              },
            }
          : {}),
      });
      expect(result.status, JSON.stringify(result)).toBe("ok");
      if (downgrade) {
        expect(state.calls.some((argv) => argv.includes("fetch"))).toBe(false);
      }
      expect(admission).toHaveBeenCalledOnce();
      if (stagedRoot) {
        expect(fs.existsSync(stagedRoot)).toBe(false);
      }
      const installed = publish ? published : state.install;
      expect(state.git(installed, "rev-parse", "HEAD")).toBe(target);
      expect(
        JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8")),
      ).toMatchObject({
        version: downgrade ? "2026.7.2-beta.1" : "2026.7.2",
      });
    },
  );

  it.each([false, true])(
    "retains imported packs through repack and publication, respecting keep ownership (foreign=%s)",
    async (foreignKeep) => {
      const state = createGitAdmissionFixture();
      const published = path.join(state.root, "published");
      let repacked = false;
      let descriptor: number | undefined;
      let keepName: string | undefined;
      const command: CommandRunner = async (argv, options) => {
        if (foreignKeep && argv[2] === state.install && argv[3] === "index-pack") {
          const pack = options.stdinFileDescriptor!;
          const trailer = Buffer.alloc(20);
          fs.readSync(pack, trailer, 0, trailer.length, fs.fstatSync(pack).size - 20);
          keepName = `pack-${trailer.toString("hex")}.keep`;
          fs.writeFileSync(
            path.join(state.install, ".git", "objects", "pack", keepName),
            "operator retention\n",
          );
        }
        const result = await state.runCommand(argv, options);
        if (argv[2] === state.install && argv[3] === "index-pack" && result.code === 0) {
          descriptor = options.stdinFileDescriptor;
          state.git(state.install, "repack", "-a", "-d");
          repacked = true;
          expect(state.git(state.install, "cat-file", "-t", state.target)).toBe("commit");
        }
        return result;
      };
      const result = await state.run(
        {
          gitArtifactStorageRoot: state.root,
          publishGitCheckout: async () => {
            fs.renameSync(state.install, published);
            return published;
          },
        },
        command,
      );
      expect(repacked).toBe(true);
      expect(descriptor).toBeTypeOf("number");
      expect(() => fs.fstatSync(descriptor!)).toThrow();
      expect(result.status, JSON.stringify(result)).toBe("ok");
      expect(state.git(published, "rev-parse", "HEAD")).toBe(state.target);
      const packs = path.join(published, ".git", "objects", "pack");
      expect(fs.readdirSync(packs).filter((name) => name.endsWith(".keep"))).toEqual(
        foreignKeep ? [keepName] : [],
      );
      if (foreignKeep) {
        assert(keepName);
        expect(fs.readFileSync(path.join(packs, keepName), "utf8")).toBe("operator retention\n");
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "refuses exhausted clone artifact storage before stopping the Gateway",
    async () => {
      const state = createGitAdmissionFixture();
      const before = state.git(state.install, "rev-parse", "HEAD");
      const artifacts = path.join(state.root, ".artifacts");
      const prepareMutation = vi.fn();
      const publish = vi.fn(async () => state.install);
      const mkdir = fsPromises.mkdir.bind(fsPromises);
      const allocation = vi
        .spyOn(fsPromises, "mkdir")
        .mockImplementation(async (target, options) => {
          if (String(target) === artifacts) {
            throw Object.assign(new Error("ENOSPC: no space left on device, mkdir"), {
              code: "ENOSPC",
            });
          }
          return mkdir(target, options);
        });
      try {
        const result = await state.run({
          gitArtifactStorageRoot: state.root,
          beforeGitMutation: prepareMutation,
          publishGitCheckout: publish,
        });
        expect(result).toMatchObject({ status: "error", reason: "preflight-insufficient-space" });
        expect(allocation).toHaveBeenCalledWith(artifacts, { recursive: true });
        expect(prepareMutation).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
        expect(state.git(state.install, "rev-parse", "HEAD")).toBe(before);
      } finally {
        allocation.mockRestore();
      }
    },
  );

  it.each(["insufficient", "reporting-rejected", "unknown"] as const)(
    "handles object-volume capacity before stopping the Gateway (%s)",
    async (outcomeKind) => {
      const state = createGitAdmissionFixture();
      const before = state.git(state.install, "rev-parse", "HEAD");
      const prepareMutation = vi.fn();
      const reportingError = new Error("Git pack capacity receipt rejected");
      const onStepComplete = vi.fn<NonNullable<UpdateStepProgress["onStepComplete"]>>(
        async (step) => {
          if (outcomeKind === "reporting-rejected" && step.name === "git update pack capacity") {
            throw reportingError;
          }
        },
      );
      const capacity = vi.spyOn(diskSpace, "tryReadDiskSpace").mockReturnValue(
        outcomeKind === "unknown"
          ? null
          : {
              targetPath: state.install,
              checkedPath: state.install,
              availableBytes: 0,
              totalBytes: 1024,
            },
      );
      try {
        const outcome = await state
          .run({
            beforeGitMutation: prepareMutation,
            progress: { onStepComplete },
          })
          .then(
            (result) => ({ result }),
            (error: unknown) => ({ error }),
          );
        if (outcomeKind === "reporting-rejected") {
          expect("error" in outcome).toBe(true);
          const errors = collectNestedErrorCandidates(
            "error" in outcome ? outcome.error : undefined,
          );
          expect(errors).toContain(reportingError);
          expect(onStepComplete).toHaveBeenCalledWith(
            expect.objectContaining({ name: "git update pack capacity", exitCode: 1 }),
          );
          expect(errors).toContainEqual(
            expect.objectContaining({
              exitCode: 1,
              stderrTail: expect.stringMatching(
                /snapshot-capacity-insufficient: Git update pack and index need [\s\S]*0 bytes available/,
              ),
            }),
          );
        } else {
          if ("error" in outcome) {
            throw outcome.error;
          }
          const { result } = outcome;
          if (outcomeKind === "unknown") {
            expect(result.status, JSON.stringify(result)).toBe("ok");
            expect(result.steps).toContainEqual(
              expect.objectContaining({
                name: "git update pack capacity",
                exitCode: 0,
                warnings: [expect.stringContaining("free space could not be measured")],
              }),
            );
          } else {
            expect(result).toMatchObject({
              status: "error",
              reason: "snapshot-capacity-insufficient",
            });
            expect(result.steps).toContainEqual(
              expect.objectContaining({
                name: "git update pack capacity",
                stderrTail: expect.stringContaining("0 bytes available"),
              }),
            );
          }
        }
        expect(prepareMutation).toHaveBeenCalledTimes(outcomeKind === "unknown" ? 1 : 0);
        expect(state.git(state.install, "rev-parse", "HEAD")).toBe(
          outcomeKind === "unknown" ? state.target : before,
        );
      } finally {
        capacity.mockRestore();
      }
    },
  );

  it("stages divergent history blobs and delta bases before taking upstream offline", async () => {
    const state = createGitAdmissionFixture(false, true);
    const historical = Array.from({ length: 2000 }, (_, index) =>
      createHash("sha256").update(`history-${index}`).digest("hex"),
    ).join("\n");
    fs.writeFileSync(path.join(state.source, "changed.txt"), historical);
    fs.writeFileSync(path.join(state.source, "unchanged.txt"), historical);
    const base = state.commit("2026.7.3", 14);
    fs.writeFileSync(path.join(state.source, "changed.txt"), "installed replacement\n");
    fs.writeFileSync(path.join(state.source, "unchanged.txt"), "installed replacement\n");
    const installed = state.commit("2026.7.4", 14);
    state.git(state.install, "fetch", "upstream.with.dots");
    state.git(state.install, "checkout", "--detach", installed);
    state.git(state.source, "checkout", "-b", "fixture-target", base);
    fs.writeFileSync(path.join(state.source, "changed.txt"), `${historical}\ncandidate edit\n`);
    const target = state.commit("2026.7.5", 14);
    const admission = vi.fn(async () => {
      // The installed partial clone has neither this historical blob nor its delta base.
      fs.renameSync(state.source, `${state.source}.offline`);
    });
    const result = await state.run({
      channel: "dev",
      devTarget: { mode: "detached", ref: target },
      beforeGitMutation: admission,
    });
    expect(result.status, JSON.stringify(result)).toBe("ok");
    expect(admission).toHaveBeenCalledOnce();
    expect(state.git(state.install, "rev-parse", "HEAD")).toBe(target);
    expect(fs.readFileSync(path.join(state.install, "changed.txt"), "utf8")).toBe(
      `${historical}\ncandidate edit\n`,
    );
    expect(fs.readFileSync(path.join(state.install, "unchanged.txt"), "utf8")).toBe(historical);
  });

  it.each([
    { phase: "staging", validRuntime: true, sourceChanged: false },
    { phase: "import", validRuntime: false, sourceChanged: false },
    { phase: "import", validRuntime: true, sourceChanged: false },
    { phase: "import" as const, validRuntime: true, sourceChanged: true },
  ])(
    "preserves the retained runtime on $phase failure (validRuntime=$validRuntime, sourceChanged=$sourceChanged)",
    async ({ phase, validRuntime, sourceChanged }) => {
      const state = createGitAdmissionFixture();
      const beforeSha = state.git(state.install, "rev-parse", "HEAD");
      const dist = path.join(state.install, "dist");
      fs.mkdirSync(path.join(dist, "control-ui"), { recursive: true });
      fs.writeFileSync(path.join(dist, "entry.js"), "export const retained = true;\n");
      fs.writeFileSync(path.join(dist, "control-ui", "index.html"), "retained UI\n");
      fs.writeFileSync(
        path.join(dist, "build-info.json"),
        JSON.stringify({ commit: beforeSha, buildId: "retained-build" }),
      );
      for (const name of [".buildstamp", ".runtime-postbuildstamp"]) {
        fs.writeFileSync(path.join(dist, name), JSON.stringify({ head: beforeSha }));
      }
      if (!validRuntime) {
        fs.rmSync(path.join(dist, ".runtime-postbuildstamp"));
      }
      const beforeRuntime = snapshotTree(dist);
      const admission = vi.fn<UpdateRunnerOptions["beforeGitMutation"]>(async (candidate) => {
        expect(candidate.sha).toBe(state.target);
        expect(state.git(state.install, "rev-parse", "HEAD")).toBe(beforeSha);
      });
      const command: CommandRunner = async (argv, options) => {
        const fail =
          phase === "staging"
            ? argv.includes("pack-objects")
            : argv[2] === state.install && argv[3] === "index-pack";
        if (argv[0] === "git" && fail) {
          expect(admission).toHaveBeenCalledTimes(phase === "staging" ? 0 : 1);
          if (sourceChanged) {
            fs.appendFileSync(path.join(state.install, "package.json"), "\n");
          }
          return { code: 128, stdout: "", stderr: "synthetic target transport failure" };
        }
        return state.runCommand(argv, options);
      };
      const result = await state.run({ beforeGitMutation: admission }, command);
      expect(result).toMatchObject({
        status: "error",
        reason: "fetch-failed",
        recovery:
          validRuntime && !sourceChanged
            ? { serviceRestartSafe: true, version: "2026.7.1", buildId: "retained-build" }
            : { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      });
      expect(admission).toHaveBeenCalledTimes(phase === "staging" ? 0 : 1);
      expect(state.git(state.install, "rev-parse", "HEAD")).toBe(beforeSha);
      expect(snapshotTree(dist)).toEqual(beforeRuntime);
    },
  );

  it("finishes with a recorded warning when inspection clone cleanup fails", async () => {
    const state = createGitAdmissionFixture();
    const remove = fsPromises.rm.bind(fsPromises);
    let retained: string | undefined;
    const denial = vi.spyOn(fsPromises, "rm").mockImplementation(async (target, options) => {
      if (
        typeof target === "string" &&
        path.basename(target).startsWith("openclaw-git-admission-")
      ) {
        retained = target;
        throw new Error("synthetic inspection cleanup denied");
      }
      return remove(target, options);
    });
    try {
      const onStepComplete = vi.fn();
      const result = await state.run({
        progress: { onStepComplete },
      });
      expect(result.status, JSON.stringify(result)).toBe("ok");
      expect(state.git(state.install, "rev-parse", "HEAD")).toBe(state.target);
      expect(onStepComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "git-target-inspection-cleanup",
          advisory: expect.objectContaining({ kind: "recoverable-maintenance" }),
        }),
      );
      expect(result.steps).toContainEqual(
        expect.objectContaining({
          name: "git-target-inspection-cleanup",
          advisory: expect.objectContaining({
            message: expect.stringContaining("synthetic inspection cleanup denied"),
          }),
        }),
      );
      expect(renderUpdateRunReport(updateRunReportInputFromResult(result)).markdown).toContain(
        "inspection cleanup",
      );
    } finally {
      denial.mockRestore();
      if (retained) {
        await remove(retained, { recursive: true, force: true });
      }
    }
  });
  it("preserves dev upstream setup from a cold tracking inventory", async () => {
    const state = createGitAdmissionFixture();
    state.git(state.install, "checkout", "-b", "maintenance");
    state.git(state.install, "branch", "-D", "main");
    state.git(state.install, "update-ref", "-d", "refs/remotes/upstream.with.dots/main");
    let restoredUpstream = false;
    const command: CommandRunner = async (argv, options) => {
      const result = await state.runCommand(argv, options);
      if (argv[2] === state.install && argv[3] === "branch" && argv[4] === "--set-upstream-to") {
        expect(result.code, result.stderr).toBe(0);
        expect(state.git(state.install, "rev-parse", "HEAD")).toBe(state.target);
        expect(state.git(state.install, "rev-parse", "main@{upstream}")).toBe(state.target);
        restoredUpstream = true;
      }
      return result;
    };
    const result = await state.run({ channel: "dev" }, command);
    expect(result.status, JSON.stringify(result)).toBe("ok");
    expect(restoredUpstream).toBe(true);
  });

  it.each(["stable", "dev"] as const)(
    "rechecks admission after transport and keeps the target pinned (%s)",
    async (channel) => {
      const state = createGitAdmissionFixture();
      let checkoutObserved = false;
      let admissionFinished = false;
      let admissionFresh = false;
      const remoteFetches: boolean[] = [];
      const admission = vi.fn<UpdateRunnerOptions["beforeGitMutation"]>(async (target) => {
        expect(target).toEqual({
          sha: state.target,
          version: "2026.7.2",
          schemaVersions: { state: 5, agent: 14 },
        });
        if (channel === "stable") {
          state.commit("2026.7.3", 15);
        }
        admissionFinished = true;
        admissionFresh = true;
      });
      const command: CommandRunner = async (argv, options) => {
        if (argv[2] === state.install && (argv[3] === "fetch" || argv[3] === "index-pack")) {
          remoteFetches.push(admissionFinished);
          admissionFresh = false;
        }
        if (argv[2] === state.install && (argv[3] === "checkout" || argv[3] === "rebase")) {
          expect(argv.at(-1)).toBe(state.target);
          expect(remoteFetches).toEqual([true]);
          expect(admissionFresh).toBe(true);
          expect(state.git(state.install, "show", `${state.target}:package.json`)).toContain(
            '"agent":14',
          );
          checkoutObserved = true;
        }
        return state.runCommand(argv, options);
      };
      const result = await state.run(
        {
          channel,
          beforeGitMutation: admission,
          inspectGitTarget: async () => {
            if (admissionFinished) {
              admissionFresh = true;
            }
          },
        },
        command,
      );
      expect(result.status, JSON.stringify(result)).toBe("ok");
      expect(checkoutObserved).toBe(true);
      expect(state.git(state.install, "rev-parse", "HEAD")).toBe(state.target);
      expect(admission).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { configuration: "global", configured: false },
    { configuration: "global", configured: true },
    { configuration: "command", configured: true },
  ] as const)(
    "uses captured transport configuration ($configuration, configured=$configured)",
    async ({ configuration, configured }) => {
      const state = createGitAdmissionFixture();
      const unresolved = pathToFileURL(path.join(state.root, "absent-remote")).href;
      const key = `url.${pathToFileURL(state.source).href}.insteadOf`;
      state.git(state.install, "remote", "set-url", "upstream.with.dots", unresolved);
      if (configuration === "global" && configured) {
        state.git(state.install, "config", "--file", state.globalConfig, key, unresolved);
      }
      const captured = await withEnvAsync(
        {
          GIT_CONFIG_GLOBAL: state.globalConfig,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_PARAMETERS: undefined,
          GIT_CONFIG_COUNT: configuration === "command" && configured ? "1" : "0",
          GIT_CONFIG_KEY_0: configuration === "command" && configured ? key : undefined,
          GIT_CONFIG_VALUE_0: configuration === "command" && configured ? unresolved : undefined,
        },
        () => buildUpdateCommandRunner(),
      );
      const before = snapshotTree(state.install);
      const refused = new Error("refuse after effective-environment transport");
      const admission = vi.fn(async (target) => {
        expect(target).toEqual({
          sha: state.target,
          version: "2026.7.2",
          schemaVersions: { state: 5, agent: 14 },
        });
        throw refused;
      });
      const result = updateGitCheckout({
        gitRoot: state.install,
        ...captured,
        timeoutMs: 15_000,
        startedAt: Date.now(),
        opts: {
          channel: "stable",
          inspectGitTarget: admission,
          validateCandidate: async () => {
            throw new Error("Refused transport must not validate a candidate");
          },
          beforeGitMutation: async () => {
            throw new Error("Refused transport must not mutate the installed checkout");
          },
          runGitDoctor: async () => {
            throw new Error("Refused transport must not run Doctor");
          },
        },
      });
      if (configured) {
        await expect(result).rejects.toBe(refused);
        expect(admission).toHaveBeenCalledOnce();
      } else {
        await expect(result).resolves.toMatchObject({ status: "error", reason: "fetch-failed" });
        expect(admission).not.toHaveBeenCalled();
      }
      expect(snapshotTree(state.install)).toEqual(before);
    },
  );

  it.each([false, true])(
    "checks development admission before target scripts, refuseFirst=%s",
    async (refuseFirst) => {
      const state = createGitAdmissionFixture();
      const newest = state.commit("2026.7.3", 15);
      const before = snapshotTree(state.install);
      const refused = new Error("fallback database refusal");
      const builds: string[] = [];
      const inspected: number[] = [];
      const runCommand: CommandRunner = async (argv, options) => {
        if (argv[0] === "git") {
          return state.runCommand(argv, options);
        }
        if (argv.includes("build")) {
          const manifest = JSON.parse(
            fs.readFileSync(path.join(options.cwd!, "package.json"), "utf8"),
          );
          builds.push(manifest.version);
          if (!refuseFirst && manifest.version === "2026.7.3") {
            return { code: 1, stdout: "", stderr: "synthetic candidate build failure" };
          }
        }
        return state.runCommand(argv, options);
      };
      await expect(
        state.run(
          {
            channel: "dev",
            inspectGitTarget: async (target) => {
              inspected.push(target.schemaVersions!.agent);
              if (refuseFirst) {
                expect(target).toEqual({
                  sha: newest,
                  version: "2026.7.3",
                  schemaVersions: { state: 5, agent: 15 },
                });
                throw refused;
              }
            },
            beforeGitMutation: async (target) => {
              expect(target).toEqual({
                sha: state.target,
                version: "2026.7.2",
                schemaVersions: { state: 5, agent: 14 },
              });
              throw refused;
            },
          },
          runCommand,
        ),
      ).rejects.toBe(refused);
      expect(builds).toEqual(refuseFirst ? [] : ["2026.7.3", "2026.7.2"]);
      expect([...new Set(inspected)]).toEqual(refuseFirst ? [15] : [15, 14]);
      expect(snapshotTree(state.install)).toEqual(before);
    },
  );

  it("fetches through a repository-local SSH command with an explicit dialect", async () => {
    const state = createGitAdmissionFixture();
    const wrapper = path.join(state.root, "ssh-wrapper.mjs");
    const transportLog = path.join(state.root, "ssh-calls.jsonl");
    fs.writeFileSync(
      wrapper,
      `import fs from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(transportLog)}, JSON.stringify(args) + "\\n");
if (args[0] !== "-P" || args[1] !== "22445" || args[2] !== "fixture.invalid") process.exit(91);
if (!args[3]?.startsWith("git-upload-pack ")) process.exit(92);
const result = spawnSync("git", ["upload-pack", ${JSON.stringify(state.source)}], { stdio: "inherit" });
process.exit(result.status ?? 93);
`,
    );
    const quote = (value: string) => `"${value.replaceAll("\\", "/")}"`;
    state.git(
      state.install,
      "config",
      "core.sshCommand",
      `${quote(process.execPath)} ${quote(wrapper)}`,
    );
    state.git(state.install, "config", "ssh.variant", "plink");
    const remote = new URL("ssh://fixture.invalid:22445");
    remote.pathname = state.source;
    state.git(state.install, "remote", "set-url", "upstream.with.dots", remote.href);
    // The installed repository can reach the fixture with this command/dialect pair.
    expect(
      state.git(state.install, "ls-remote", "upstream.with.dots", "refs/heads/main"),
    ).toContain(state.target);
    const before = snapshotTree(state.install);
    const refused = new Error("stop after real SSH transport and target admission");
    await expect(
      state.run({
        inspectGitTarget: async () => {
          throw refused;
        },
      }),
    ).rejects.toBe(refused);
    const calls = fs
      .readFileSync(transportLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.every((args) => args[0] === "-P" && args[1] === "22445")).toBe(true);
    expect(snapshotTree(state.install)).toEqual(before);
  });

  it.each([false, true])("publishes only an admitted checkout (refuse=%s)", async (refuse) => {
    const state = createGitAdmissionFixture();
    const published = path.join(state.root, "published");
    const complete = new Error("refuse publication");
    const publish = vi.fn(async () => {
      expect(state.git(state.install, "show", `${state.target}:package.json`)).toContain(
        '"agent":14',
      );
      fs.renameSync(state.install, published);
      return published;
    });
    const result = state.run({
      beforeGitMutation: async (target) => {
        expect(fs.existsSync(published)).toBe(false);
        expect(target).toEqual({
          sha: state.target,
          version: "2026.7.2",
          schemaVersions: { state: 5, agent: 14 },
        });
        if (refuse) {
          throw complete;
        }
      },
      publishGitCheckout: publish,
      gitArtifactStorageRoot: state.root,
    });
    if (refuse) {
      await expect(result).rejects.toBe(complete);
    } else {
      await expect(result).resolves.toMatchObject({
        status: "ok",
        root: published,
        after: { sha: state.target },
      });
    }
    expect(publish).toHaveBeenCalledTimes(refuse ? 0 : 1);
    expect(fs.existsSync(published)).toBe(!refuse);
  });
  it.each([
    { relative: true, shallow: false },
    { relative: false, shallow: true },
  ])(
    "refuses before installed Git writes (relative remote=$relative, shallow=$shallow)",
    async ({ relative, shallow }) => {
      const state = createGitAdmissionFixture(relative, shallow, shallow);
      if (shallow) {
        expect(
          state.git(state.install, "rev-list", "--objects", "--missing=print", "--all"),
        ).toMatch(/^\?/m);
      }
      // Unchanged content with a stale index stat cache must remain read-only too.
      fs.utimesSync(path.join(state.install, "package.json"), new Date(1000), new Date(1000));
      const before = snapshotTree(state.install);
      const refusal = new Error("incompatible database");
      const inspect = vi.fn(async (target) => {
        expect(target).toEqual({
          sha: state.target,
          version: "2026.7.2",
          schemaVersions: { state: 5, agent: 14 },
        });
        throw refusal;
      });
      await expect(state.run({ inspectGitTarget: inspect })).rejects.toBe(refusal);
      expect(inspect).toHaveBeenCalledOnce();
      expect(snapshotTree(state.install)).toEqual(before);
      const mirror = state.calls.find((argv) => argv.includes("init"))?.at(-1);
      expect(mirror).toBeDefined();
      expect(fs.existsSync(mirror!)).toBe(false);
    },
  );
});
