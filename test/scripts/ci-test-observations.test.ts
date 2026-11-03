import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCiTestObservationCapture } from "../../scripts/lib/ci-test-observation-capture.mts";
import { collectTestObservations } from "../../scripts/lib/ci-test-observations.mjs";

const context = {
  repository: "example/project",
  revision: "a".repeat(40),
  tree: "b".repeat(40),
  configDigest: "c".repeat(64),
  lockDigest: "d".repeat(64),
  environmentDigest: "e".repeat(64),
};
const file = { file: "src/example.test.ts", project: "unit", pool: "forks" };
function receipts(options: { skipped?: number; interrupted?: boolean; failed?: boolean } = {}) {
  const row = (kind: string, value: unknown) =>
    `[shard:unit] [vitest:${kind}] ${JSON.stringify(value)}`;
  return [
    row("inventory", {
      version: 1,
      dependencyRoot: "",
      invocation: "run-1",
      runtime: "bun",
      runtimeVersion: "1.4.4",
      platform: "linux",
      arch: "x64",
      files: [file],
    }),
    row("module", {
      ...file,
      observationFile: file.file,
      invocation: "run-1",
      state: options.failed ? "failed" : "passed",
      cases: {
        passed: 1,
        failed: Number(Boolean(options.failed)),
        skipped: options.skipped ?? 0,
        pending: 0,
      },
      diagnostic: { duration: 12 },
      error: "must not be copied",
    }),
    row("run", {
      invocation: "run-1",
      reason: options.interrupted ? "interrupted" : options.failed ? "failed" : "passed",
      files: 1,
      unhandledErrors: 0,
      elapsedMs: 100,
    }),
  ];
}
const dependencies = {
  version: 1,
  projects: { unit: { modules: ["src/example.ts"], files: { [file.file]: [0] } } },
};

describe("CI observation export", () => {
  it.each([false, true])(
    "captures native outcomes and dependencies without log contents (failed=%s)",
    (failed) => {
      const directory = mkdtempSync(path.join(tmpdir(), "ci-observation-capture-"));
      try {
        const cacheDirectory = path.join(directory, "vite");
        mkdirSync(cacheDirectory);
        writeFileSync(path.join(cacheDirectory, "dependencies.json"), JSON.stringify(dependencies));
        const capture = createCiTestObservationCapture({
          repositoryRoot: process.cwd(),
          cacheDirectory,
          configFiles: [path.resolve("test/vitest/vitest.unit-fast.config.ts")],
          configuration: { pool: "forks", isolate: false },
          env: {
            GITHUB_REPOSITORY: "example/project",
            GITHUB_RUN_ID: "100",
            GITHUB_RUN_ATTEMPT: "2",
            OPENCLAW_VITEST_OBSERVATION_DIR: directory,
          },
        });
        expect(capture).toBeDefined();
        for (const line of receipts({ failed })) {
          const match = /\[vitest:(\w+)\] (.*)/u.exec(line)!;
          capture!.record(match[1]!, JSON.parse(match[2]!));
        }
        const text = readFileSync(path.join(directory, "observations.json"), "utf8");
        expect(text).not.toContain("must not be copied");
        expect(text).not.toContain(directory);
        expect(text).not.toContain(process.cwd());
        expect(JSON.parse(text)).toMatchObject({
          source: { runId: "100", runAttempt: "2" },
          observations: {
            context: {
              repository: "example/project",
              revision: expect.stringMatching(/^[a-f0-9]{40}$/u),
            },
            invocations: [
              {
                complete: true,
                files: [
                  {
                    outcome: failed ? "failed" : "passed",
                    dependencies: ["src/example.test.ts", "src/example.ts"],
                  },
                ],
              },
            ],
          },
        });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("keeps interrupted observations incomplete when native dependencies are missing", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ci-observation-capture-"));
    try {
      const capture = createCiTestObservationCapture({
        repositoryRoot: process.cwd(),
        cacheDirectory: directory,
        configFiles: [],
        configuration: {},
        env: { OPENCLAW_VITEST_OBSERVATION_DIR: directory },
      });
      for (const line of receipts({ interrupted: true })) {
        const match = /\[vitest:(\w+)\] (.*)/u.exec(line)!;
        capture!.record(match[1]!, JSON.parse(match[2]!));
      }
      expect(
        JSON.parse(readFileSync(path.join(directory, "observations.json"), "utf8")),
      ).toMatchObject({
        observations: {
          invocations: [
            {
              complete: false,
              files: [{ complete: false, outcome: "unknown", dependencies: null }],
            },
          ],
        },
      });
      const unavailable = createCiTestObservationCapture({
        repositoryRoot: path.join(directory, "missing"),
        cacheDirectory: directory,
        configFiles: [],
        configuration: {},
        env: { OPENCLAW_VITEST_OBSERVATION_DIR: directory },
      });
      expect(() => unavailable!.record("run", {})).not.toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("exports through the operator command", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ci-observations-"));
    try {
      writeFileSync(path.join(root, "run.log"), receipts().join("\n"));
      writeFileSync(path.join(root, "context.json"), JSON.stringify(context));
      const result = spawnSync(
        process.execPath,
        [
          "scripts/ci-test-observations.mjs",
          "--log",
          path.join(root, "run.log"),
          "--context",
          path.join(root, "context.json"),
          "--output",
          path.join(root, "observations.json"),
        ],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(path.join(root, "observations.json"), "utf8"))).toMatchObject({
        context,
        invocations: [{ complete: true }],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("joins native outcomes and dependency identity without copying log contents", () => {
    const lines = receipts({ failed: true });
    lines.push(`[shard-failure:unit:tail] ${lines[1]}`);
    const report = collectTestObservations(lines.join("\n"), context, dependencies);
    expect(report.invocations[0]).toMatchObject({
      runtime: "bun",
      complete: true,
      elapsedMs: 100,
      files: [
        { ...file, complete: true, outcome: "failed", dependencies: [file.file, "src/example.ts"] },
      ],
    });
    expect(JSON.stringify(report)).not.toContain("must not be copied");
  });

  it.each(
    [receipts({ skipped: 1 }), receipts({ interrupted: true }), receipts().slice(0, 2)].map(
      (lines) => ({ lines }),
    ),
  )("does not turn filtered or incomplete execution into a negative label", ({ lines }) => {
    const report = collectTestObservations(lines.join("\n"), context, dependencies);
    expect(report.invocations[0]?.complete).toBe(false);
    expect(report.invocations[0]?.files[0]).toMatchObject({ complete: false, outcome: "unknown" });
  });

  it("includes global setup dependencies and rejects ambiguous cache bindings", () => {
    const graph = {
      version: 1,
      projects: {
        unit: {
          modules: ["src/example.ts", "test/setup.ts"],
          files: { [file.file]: [0] },
          globalSetup: [1],
        },
      },
    };
    const log = receipts().join("\n");
    expect(
      collectTestObservations(log, context, graph).invocations[0]?.files[0]?.dependencies,
    ).toContain("test/setup.ts");
    const mixed = log + "\n" + log.replaceAll("run-1", "run-2").replaceAll('"bun"', '"node"');
    expect(
      collectTestObservations(mixed, context, graph).invocations.every(
        (run) => run.files[0]?.dependencies === null,
      ),
    ).toBe(true);
    graph.projects.unit.globalSetup = [99];
    expect(
      collectTestObservations(log, context, graph).invocations[0]?.files[0]?.dependencies,
    ).toBeNull();
  });

  it("rebases native UI-root dependency paths onto the repository", () => {
    const log = receipts()
      .join("\n")
      .replaceAll(file.file, `ui/${file.file}`)
      .replace('"dependencyRoot":""', '"dependencyRoot":"ui"');
    const observation = collectTestObservations(log, context, dependencies).invocations[0]
      ?.files[0];
    expect(observation).toMatchObject({
      file: `ui/${file.file}`,
      dependencies: [`ui/${file.file}`, "ui/src/example.ts"],
    });
  });

  it("keeps missing dependency data distinct from a completed test outcome", () => {
    const report = collectTestObservations(receipts().join("\n"), context);
    expect(report.invocations[0]?.files[0]).toMatchObject({
      complete: true,
      outcome: "passed",
      dependencies: null,
    });
  });

  it("rejects duplicate outcomes and unsafe identities", () => {
    const lines = receipts();
    expect(() =>
      collectTestObservations([lines[0], lines[1], lines[1], lines[2]].join("\n"), context),
    ).toThrow("Duplicate outcome");
    expect(() =>
      collectTestObservations(lines.join("\n"), { ...context, tree: "unknown" }),
    ).toThrow("Invalid tree");
    expect(() =>
      collectTestObservations(
        lines.join("\n").replaceAll(file.file, "../private.test.ts"),
        context,
      ),
    ).toThrow("Invalid observation");
  });
});
