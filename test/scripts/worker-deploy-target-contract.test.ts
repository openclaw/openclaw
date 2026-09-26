import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFrozenTargetSource } from "../../scripts/lib/frozen-target-source.mjs";
import { resolveVitestNodeArgs } from "../../scripts/lib/vitest-process-env.mts";
import {
  readPublishedWorkerDeployTargetPaths,
  readWorkerDeployTargetPaths,
} from "../../scripts/lib/worker-deploy-target-contract.mts";
import { WORKER_BUNDLE_ARTIFACT_PATHS } from "../../src/shared/worker-bundle-hash.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { createCommandTest } from "../helpers/command-fixture.js";
import { createTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = createTempDirTracker();
afterEach(() => tempDirs.cleanup());

function target(source: string) {
  const root = tempDirs.make("worker-deploy-target-");
  const declaration = join(root, "src/shared/worker-bundle-hash.ts");
  const producer = join(root, "src/worker/worker-deploy-entry.ts");
  mkdirSync(dirname(declaration), { recursive: true });
  mkdirSync(dirname(producer), { recursive: true });
  writeFileSync(declaration, source);
  writeFileSync(producer, "export {};\n");
  return { root, declaration, producer };
}

function frozenTarget(producer = true) {
  const fixture = target(
    'export const WORKER_BUNDLE_ARTIFACT_PATHS = ["worker.mjs", "helper.mjs"];',
  );
  if (!producer) {
    rmSync(fixture.producer);
    rmSync(fixture.declaration);
  }
  const version = "2026.9.4";
  writeFileSync(join(fixture.root, "package.json"), JSON.stringify({ name: "openclaw", version }));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-C",
        fixture.root,
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        ...args,
      ],
      {
        env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
      },
    ).trim();
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "fixture");
  return {
    ...fixture,
    git,
    params: { targetRoot: fixture.root, targetSha: git("rev-parse", "HEAD"), version },
  };
}

describe("published worker source admission", () => {
  it("reads the selected committed contract while allowing unrelated evidence", () => {
    const fixture = frozenTarget();
    writeFileSync(join(fixture.root, "release-evidence.json"), "{}\n");
    expect(readPublishedWorkerDeployTargetPaths(fixture.params)).toEqual([
      "dist/worker/helper.mjs",
      "dist/worker/worker.mjs",
    ]);
  });

  it("admits historical producer absence only for the selected package version", () => {
    const fixture = frozenTarget(false);
    expect(readPublishedWorkerDeployTargetPaths(fixture.params)).toEqual([]);
    expect(() =>
      readPublishedWorkerDeployTargetPaths({ ...fixture.params, version: "2026.9.5" }),
    ).toThrow("does not match release tag v2026.9.5");
  });

  it("rejects missing, non-repository, nested and wrong-HEAD roots", () => {
    const fixture = frozenTarget(false);
    for (const root of [join(fixture.root, "missing"), tempDirs.make("non-repository-")]) {
      expect(() =>
        readPublishedWorkerDeployTargetPaths({ ...fixture.params, targetRoot: root }),
      ).toThrow("unable to read selected source");
    }
    expect(() =>
      readPublishedWorkerDeployTargetPaths({
        ...fixture.params,
        targetRoot: join(fixture.root, "src"),
      }),
    ).toThrow("selected source must be the repository root");
    expect(() =>
      readPublishedWorkerDeployTargetPaths({ ...fixture.params, targetSha: "0".repeat(40) }),
    ).toThrow("selected source checkout does not match");
  });

  it.each([false, true])("rejects tracked contract changes (staged=%s)", (staged) => {
    const fixture = frozenTarget();
    const original = readFileSync(fixture.declaration, "utf8");
    writeFileSync(fixture.declaration, "export const WORKER_BUNDLE_ARTIFACT_PATHS = [];\n");
    if (staged) {
      fixture.git("add", "src/shared/worker-bundle-hash.ts");
      // The worktree matches HEAD, but the index still carries a different contract.
      writeFileSync(fixture.declaration, original);
    }
    expect(() => readPublishedWorkerDeployTargetPaths(fixture.params)).toThrow(
      "selected source has tracked or index changes",
    );
    // Existing frozen-source users still read committed objects without clean admission.
    expect(
      createFrozenTargetSource(fixture.root, fixture.params.targetSha).readText(
        "src/shared/worker-bundle-hash.ts",
      ),
    ).toBe(original);
  });

  it.each(["src/worker/worker-deploy-entry.ts", "src/shared/worker-bundle-hash.ts"])(
    "rejects an untracked contract input even when ignored: %s",
    (path) => {
      const fixture = frozenTarget(false);
      writeFileSync(join(fixture.root, ".git/info/exclude"), "src/\n");
      writeFileSync(join(fixture.root, path), "export {};\n");
      expect(() => readPublishedWorkerDeployTargetPaths(fixture.params)).toThrow(
        "selected source has untracked contract inputs",
      );
    },
  );

  it("rejects an untracked producer reached through a parent symlink", () => {
    const fixture = frozenTarget(false);
    const external = tempDirs.make("untracked-worker-source-");
    writeFileSync(join(external, "worker-deploy-entry.ts"), "export {};\n");
    rmSync(dirname(fixture.producer), { recursive: true });
    symlinkSync(external, dirname(fixture.producer), "dir");
    expect(() => readPublishedWorkerDeployTargetPaths(fixture.params)).toThrow(
      "selected source has untracked contract inputs",
    );
  });

  it("requires a correction's base tag to resolve to the exact selected product SHA", () => {
    const fixture = frozenTarget(false);
    const params = { ...fixture.params, version: "2026.9.4-1" };
    expect(() => readPublishedWorkerDeployTargetPaths(params)).toThrow(
      "unable to read selected source",
    );
    fixture.git("tag", "v2026.9.4");
    expect(readPublishedWorkerDeployTargetPaths(params)).toEqual([]);
    fixture.git("commit", "--allow-empty", "-qm", "different source commit");
    expect(() =>
      readPublishedWorkerDeployTargetPaths({
        ...params,
        targetSha: fixture.git("rev-parse", "HEAD"),
      }),
    ).toThrow("release base tag v2026.9.4 does not resolve to selected source");
  });
});

describe("postpublish CLI source admission", () => {
  const commandIt = createCommandTest();

  commandIt("rejects a missing published target before registry access", async ({ command }) => {
    const root = command.createTempDir("postpublish-source-admission-");
    const networkGuard = join(root, "no-network.mjs");
    writeFileSync(
      networkGuard,
      'globalThis.fetch = () => { throw new Error("unexpected registry access"); };\n',
    );
    const result = await command.run(
      resolveTestNodeExecPath(),
      [
        ...resolveVitestNodeArgs(),
        "--import",
        networkGuard,
        "--import",
        resolve("scripts/tsx.mjs"),
        resolve("scripts/openclaw-npm-postpublish-verify.ts"),
        "2026.9.4",
        join(root, "missing"),
        "a".repeat(40),
      ],
      { env: { ...process.env, TSX_TSCONFIG_PATH: resolve("tsconfig.json") } },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unable to read selected source");
    expect(result.stderr).not.toContain("unexpected registry access");
  });
});

describe("readWorkerDeployTargetPaths", () => {
  it("reads every artifact declared by the current producer", () => {
    expect(readWorkerDeployTargetPaths(resolve())).toEqual(
      WORKER_BUNDLE_ARTIFACT_PATHS.map((path) => `dist/worker/${path}`).toSorted(),
    );
  });

  it("prefers the canonical array and resolves local constants without executing target code", () => {
    const { root } = target(`
      throw new Error("target declarations must not execute");
      const entry = "nested/worker.mjs";
      const alias = entry;
      export const WORKER_BUNDLE_UNUSED_PATH = "unused.mjs";
      export const WORKER_BUNDLE_ARTIFACT_PATHS = [
        alias, "service-child-relay.mjs", "service-child-group-anchor.mjs",
      ] as const;
    `);
    expect(readWorkerDeployTargetPaths(root)).toEqual([
      "dist/worker/nested/worker.mjs",
      "dist/worker/service-child-group-anchor.mjs",
      "dist/worker/service-child-relay.mjs",
    ]);
  });

  it("keeps the exported-constant contract for historical producers", () => {
    const { root } = target(`
      export const WORKER_BUNDLE_ENTRY_PATH = "worker.mjs";
      export const WORKER_BUNDLE_RSYNC_RECEIVER_PATH = "workspace-rsync-receiver.mjs";
      const WORKER_BUNDLE_PRIVATE_PATH = "private.mjs";
    `);
    expect(readWorkerDeployTargetPaths(root)).toEqual([
      "dist/worker/worker.mjs",
      "dist/worker/workspace-rsync-receiver.mjs",
    ]);
  });

  it("honors a locally re-exported canonical array over historical constants", () => {
    const { root } = target(`
      export const WORKER_BUNDLE_ENTRY_PATH = "unused.mjs";
      const paths = ["worker.mjs", "helper.mjs"] as const;
      export { paths as WORKER_BUNDLE_ARTIFACT_PATHS };
    `);
    expect(readWorkerDeployTargetPaths(root)).toEqual([
      "dist/worker/helper.mjs",
      "dist/worker/worker.mjs",
    ]);
  });

  it("does not read declarations when the frozen target has no worker producer", () => {
    const { root, producer, declaration } = target("not valid TypeScript");
    rmSync(producer);
    expect(readWorkerDeployTargetPaths(root)).toEqual([]);
    rmSync(declaration);
    expect(readWorkerDeployTargetPaths(root)).toEqual([]);
  });

  it.each([
    ["empty array", "export const WORKER_BUNDLE_ARTIFACT_PATHS = [];"],
    ["undefined array", "export const WORKER_BUNDLE_ARTIFACT_PATHS = undefined;"],
    ["duplicate paths", 'export const WORKER_BUNDLE_ARTIFACT_PATHS = ["a.mjs", "a.mjs"];'],
    ["mutable declaration", 'export let WORKER_BUNDLE_ARTIFACT_PATHS = ["a.mjs"];'],
    ["computed member", 'export const WORKER_BUNDLE_ARTIFACT_PATHS = [String("a.mjs")];'],
    ["spread", 'const paths = ["a.mjs"]; export const WORKER_BUNDLE_ARTIFACT_PATHS = [...paths];'],
    [
      "imported reference",
      'import { entry } from "./other.js"; export const WORKER_BUNDLE_ARTIFACT_PATHS = [entry];',
    ],
    ["external export", 'export { paths as WORKER_BUNDLE_ARTIFACT_PATHS } from "./other.js";'],
    [
      "destructured export",
      'export const { WORKER_BUNDLE_ARTIFACT_PATHS } = { WORKER_BUNDLE_ARTIFACT_PATHS: ["a.mjs"] };',
    ],
    ["cycle", "const a = b; const b = a; export const WORKER_BUNDLE_ARTIFACT_PATHS = [a];"],
    ["unsafe path", 'export const WORKER_BUNDLE_ARTIFACT_PATHS = ["../outside.mjs"];'],
    ["non-normalized path", 'export const WORKER_BUNDLE_ARTIFACT_PATHS = ["a/../b.mjs"];'],
    ["absolute path", 'export const WORKER_BUNDLE_ARTIFACT_PATHS = ["/worker.mjs"];'],
    ["Windows path", 'export const WORKER_BUNDLE_ARTIFACT_PATHS = ["C:\\\\worker.mjs"];'],
    ["syntax error", "export const WORKER_BUNDLE_ARTIFACT_PATHS = [;"],
    [
      "too many artifacts",
      `export const WORKER_BUNDLE_ARTIFACT_PATHS = ${JSON.stringify(Array.from({ length: 17 }, (_, index) => `${index}.mjs`))};`,
    ],
  ])("rejects %s instead of falling back to an incomplete historical contract", (_name, source) => {
    const { root } = target(`export const WORKER_BUNDLE_ENTRY_PATH = "worker.mjs";\n${source}`);
    expect(() => readWorkerDeployTargetPaths(root)).toThrow();
  });

  it("rejects oversized and non-regular declaration inputs", () => {
    const { root, declaration } = target("export {};");
    truncateSync(declaration, 64 * 1024 + 1);
    expect(() => readWorkerDeployTargetPaths(root)).toThrow("at most 64 KiB");
    rmSync(declaration);
    mkdirSync(declaration);
    expect(() => readWorkerDeployTargetPaths(root)).toThrow("regular file");
    rmSync(declaration, { recursive: true });
    const other = join(root, "other.ts");
    writeFileSync(other, 'export const WORKER_BUNDLE_ENTRY_PATH = "worker.mjs";');
    symlinkSync(other, declaration);
    expect(() => readWorkerDeployTargetPaths(root)).toThrow("regular file");
  });
});
