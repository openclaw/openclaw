import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { captureAdaptiveGraphDecision } from "../../scripts/lib/ci-adaptive-decision.mts";
import {
  collectTestObservations,
  compactTestObservations,
} from "../../scripts/lib/ci-test-observations.mjs";

it.each([false, true])(
  "uses a bound preflight diff in a shallow checkout (compact=%s)",
  (compact) => {
    const root = mkdtempSync(path.join(tmpdir(), "ci-decision-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    const commit = () => {
      git("add", "src");
      git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "fixture",
      );
      return git("rev-parse", "HEAD");
    };
    try {
      mkdirSync(path.join(root, "src"));
      mkdirSync(path.join(root, ".artifacts"));
      git("init", "-q");
      writeFileSync(path.join(root, ".gitignore"), ".artifacts/\n");
      git("add", ".gitignore");
      for (const name of ["a", "b"]) {
        writeFileSync(path.join(root, `src/${name}.ts`), "export const value = 1;\n");
      }
      const base = commit();
      const baseTree = git("rev-parse", "HEAD^{tree}");
      const context = {
        repository: "example/project",
        revision: base,
        tree: baseTree,
        configDigest: "c".repeat(64),
        lockDigest: "d".repeat(64),
        environmentDigest: "e".repeat(64),
      };
      const files = ["a", "b"].map((name) => ({
        file: `src/${name}.test.ts`,
        project: "unit",
        pool: "threads",
      }));
      const inventory = {
        version: 1,
        invocation: "run",
        runtime: "node",
        runtimeVersion: "v26.13.0",
        platform: "linux",
        arch: "x64",
        dependencyRoot: "",
        files,
      };
      const row = (kind: string, data: unknown) => `[vitest:${kind}] ${JSON.stringify(data)}`;
      const receipts = [
        row("inventory", inventory),
        ...files.map((file) =>
          row("module", {
            ...file,
            observationFile: file.file,
            invocation: "run",
            state: "passed",
            cases: { passed: 1, failed: 0, skipped: 0, pending: 0 },
            diagnostic: { duration: 10 },
          }),
        ),
        row("run", { invocation: "run", reason: "passed", files: 2, unhandledErrors: 0 }),
      ];
      const baseline = collectTestObservations(receipts.join("\n"), context, {
        version: 1,
        projects: {
          unit: {
            modules: ["src/a.ts", "src/b.ts"],
            files: { "src/a.test.ts": [0], "src/b.test.ts": [1] },
          },
        },
      });
      writeFileSync(path.join(root, "src/a.ts"), "export const value = 2;\n");
      const head = commit();
      const headTree = git("rev-parse", "HEAD^{tree}");
      writeFileSync(path.join(root, ".git/shallow"), `${head}\n`);
      const current = collectTestObservations(row("inventory", inventory), {
        ...context,
        revision: head,
        tree: headTree,
      });
      const env = { GITHUB_RUN_ID: "200", GITHUB_RUN_ATTEMPT: "1" };
      const bundle = {
        version: 1,
        repository: context.repository,
        cutoffAt: "2026-11-04T00:00:00Z",
        restoredAt: "2026-11-04T00:00:01Z",
        consumer: { runId: "200", runAttempt: "1", revision: head, tree: headTree },
        candidates: [
          {
            artifactId: 10,
            runId: 100,
            runAttempt: 1,
            createdAt: "2026-11-03T23:59:00Z",
            archiveSha256: "a".repeat(64),
            memberPath: "node-run/observations.json",
            memberSha256: "b".repeat(64),
            observations: { observations: compact ? compactTestObservations(baseline) : baseline },
            comparison: {
              baseRevision: base,
              baseTree,
              headRevision: head,
              headTree,
              changedFiles: ["src/a.ts"],
            },
          },
        ],
        fallbackReasons: [],
      };
      const target = path.join(root, ".artifacts/ci-adaptive-priors.json");
      const write = () => writeFileSync(target, JSON.stringify(bundle));
      write();
      const options = {
        repositoryRoot: root,
        observations: current,
        env,
        recordedAt: "2026-11-04T00:00:02Z",
      };
      const decision = captureAdaptiveGraphDecision(options);
      expect(decision.comparison).toEqual({
        revision: base,
        tree: baseTree,
        changedFiles: ["src/a.ts"],
      });
      expect(decision.prior).toMatchObject({ artifactId: 10, memberSha256: "b".repeat(64) });
      expect(decision.graph?.candidateFiles).toEqual([
        { ...files[0], reasons: ["dependency-change"] },
      ]);
      expect(decision.scheduledFiles).toEqual(files);
      expect(decision.ranking?.rows).toEqual([
        { ...files[0], score: 0.9565217391304348, unknownReasons: [] },
        { ...files[1], score: 0, unknownReasons: [] },
      ]);
      const frozen = JSON.stringify(decision);
      writeFileSync(target, "{}");
      expect(JSON.stringify(decision)).toBe(frozen);
      for (const file of current.invocations[0]!.files) {
        expect(file.outcome).toBe("unknown");
      }

      for (const reason of [
        "future",
        "consumer",
        "context",
        "missing-source",
        "runtime",
        "date-type",
        "hash-type",
        "comparison-head",
        "comparison-tree",
        "comparison-path",
      ] as const) {
        const invalid = structuredClone(bundle);
        if (reason === "future") {
          invalid.restoredAt = "2026-11-04T00:01:00Z";
        }
        if (reason === "consumer") {
          invalid.consumer.runId = "201";
        }
        if (reason === "context") {
          invalid.candidates[0]!.observations.observations.context.lockDigest = "f".repeat(64);
        }
        if (reason === "missing-source") {
          invalid.candidates[0]!.observations.observations.context.revision = "f".repeat(40);
        }
        if (reason === "runtime") {
          invalid.candidates[0]!.observations.observations.invocations[0]!.runtime = "bun";
        }
        if (reason === "date-type") {
          Object.assign(invalid, { restoredAt: [invalid.restoredAt] });
        }
        if (reason === "hash-type") {
          Object.assign(invalid.candidates[0]!, { memberSha256: ["b".repeat(64)] });
        }
        if (reason === "comparison-head") {
          invalid.candidates[0]!.comparison.headRevision = base;
        }
        if (reason === "comparison-tree") {
          invalid.candidates[0]!.comparison.baseTree = headTree;
        }
        if (reason === "comparison-path") {
          invalid.candidates[0]!.comparison.changedFiles = ["../outside.ts"];
        }
        writeFileSync(target, JSON.stringify(invalid));
        const fallback = captureAdaptiveGraphDecision(options);
        expect(fallback.graph, reason).toBeNull();
        expect(fallback.fallbackReasons.length, reason).toBeGreaterThan(0);
        expect(fallback.scheduledFiles, reason).toEqual(files);
      }
      write();
      writeFileSync(path.join(root, "untracked.ts"), "export {};\n");
      expect(captureAdaptiveGraphDecision(options).fallbackReasons).toContain("dirty-checkout");
      expect(readFileSync(target, "utf8")).toBe(JSON.stringify(bundle));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
