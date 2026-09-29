import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { create as createTar } from "tar";
import { globSync } from "tinyglobby";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestUserConfig } from "vitest/config";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";
import { createE2EVitestConfig } from "./vitest/vitest.e2e.config.ts";
import liveConfig from "./vitest/vitest.live.config.ts";
import { createScopedVitestConfig } from "./vitest/vitest.scoped-config.ts";
import { tuiPtyTestFiles } from "./vitest/vitest.test-shards.mjs";
import { createToolingVitestConfig } from "./vitest/vitest.tooling.config.ts";
import { createTuiPtyVitestConfig } from "./vitest/vitest.tui-pty.config.ts";
import { createUiE2eVitestConfig } from "./vitest/vitest.ui-e2e.config.ts";

const candidateFiles = [
  "test/e2e/qa-lab/plugins/feishu-crabline.real-gateway.candidate.e2e.test.mts",
  "test/e2e/qa-lab/plugins/slack-crabline-roundtrip.candidate.e2e.test.mts",
];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

function writeTestFiles(root: string, files: string[]): void {
  for (const file of files) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "");
  }
}

function discover(test: TestUserConfig | undefined, cwd: string): string[] {
  if (!test?.include) {
    throw new Error("Expected an explicit test inventory");
  }
  // Match Vitest's globProjectFiles options without loading any test bodies or setup.
  return globSync(test.include, {
    cwd,
    dot: true,
    ignore: test.exclude,
    expandDirectories: false,
  }).toSorted();
}

describe("specialized Vitest discovery", () => {
  it.each(["directory", "explicit"])(
    "keeps candidate tests out of %s tooling selections",
    (selection) => {
      const root = tempDirs.make("openclaw-specialized-discovery-");
      const ordinary = ["test/ordinary.test.mts", "test/ordinary.test.ts"];
      const files = [
        ...ordinary,
        ...candidateFiles,
        "test/example.e2e.test.ts",
        "test/example.live.test.mts",
        "test/example.live.test.ts",
      ];
      writeTestFiles(root, files);
      const includeFile = path.join(root, "include.json");
      fs.writeFileSync(
        includeFile,
        JSON.stringify(selection === "directory" ? ["test/**/*.test.*"] : files),
      );
      const config = createToolingVitestConfig({ OPENCLAW_VITEST_INCLUDE_FILE: includeFile });

      expect(discover(config.test, root)).toEqual(ordinary);
    },
  );

  it("preserves ordinary tests while excluding specialized tests inside a scoped project", () => {
    const root = tempDirs.make("openclaw-specialized-scoped-");
    writeTestFiles(root, [
      "extensions/example/src/ordinary.test.mts",
      "extensions/example/src/candidate.e2e.test.mts",
      "extensions/example/src/example.live.test.cts",
    ]);
    const config = createScopedVitestConfig(["extensions/example/**/*.test.*"], {
      dir: "extensions",
      env: {},
      argv: ["node", "vitest", "run"],
    });

    expect(discover(config.test, path.join(root, "extensions"))).toEqual([
      "example/src/ordinary.test.mts",
    ]);
  });

  it("preserves dedicated E2E, live, and TUI inventories", () => {
    const root = tempDirs.make("openclaw-specialized-owners-");
    const tuiFile = tuiPtyTestFiles[0]!;
    writeTestFiles(root, ["test/example.e2e.test.ts", "test/example.live.test.ts", tuiFile]);
    const includeFile = path.join(root, "include.json");
    fs.writeFileSync(includeFile, JSON.stringify([tuiFile]));
    const tuiConfig = createTuiPtyVitestConfig({ OPENCLAW_VITEST_INCLUDE_FILE: includeFile });

    expect(discover(createE2EVitestConfig({}).test, root)).toEqual(["test/example.e2e.test.ts"]);
    expect(discover(liveConfig.test, root)).toEqual(["test/example.live.test.ts"]);
    expect(discover(tuiConfig.test, path.join(root, "src"))).toEqual([
      tuiFile.replace(/^src\//u, ""),
    ]);
  });

  it("preserves each Control UI E2E project inventory", () => {
    const root = tempDirs.make("openclaw-specialized-ui-");
    const files = [
      "ui/src/e2e/example.e2e.test.ts",
      "ui/src/e2e/board-fixture.e2e.test.ts",
      "ui/src/e2e/chat-stream-runtime-budgets.e2e.test.ts",
      "ui/src/e2e/agent-file-lifecycle.real-gateway.e2e.test.ts",
    ];
    writeTestFiles(root, files);
    const config = createUiE2eVitestConfig({}, ["node", "vitest", "run"]);

    expect(discover(config.test, root)).toEqual(files.toSorted());
    expect(
      config.test?.projects?.map((project) => {
        if (typeof project !== "object" || !("test" in project)) {
          throw new Error("Expected an inline Control UI project");
        }
        return { name: project.test?.name, files: discover(project.test, root) };
      }),
    ).toEqual([
      { name: "ui-e2e-bundled", files: [files[0]] },
      { name: "ui-e2e-standalone", files: [files[1]] },
      { name: "ui-e2e-serial", files: [files[2]] },
      { name: "ui-e2e-serial-standalone", files: [files[3]] },
    ]);
  });

  it("keeps candidate proof explicitly gated", async () => {
    vi.stubEnv("CRABLINE_CANDIDATE_ROOT", undefined);
    await expect(import("./vitest/vitest.crabline-candidate.config.ts")).rejects.toThrow(
      "CRABLINE_CANDIDATE_ROOT is required for the selected Crabline candidate",
    );
  });

  it("discovers both candidate suites through their verified dedicated config", async () => {
    const root = tempDirs.make("openclaw-specialized-candidate-");
    const packageRoot = path.join(root, "package");
    fs.mkdirSync(packageRoot);
    const files = {
      "index.d.ts": "export declare const candidate: true;\n",
      "index.js": "export const candidate = true;\n",
      "package.json": JSON.stringify({
        name: "@openclaw/crabline",
        type: "module",
        exports: { ".": { import: "./index.js", types: "./index.d.ts" } },
      }),
    };
    const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
    const inventory = Object.entries(files).map(([file, contents]) => {
      fs.writeFileSync(path.join(packageRoot, file), contents);
      return `${file}\0${sha256(contents)}\0${Buffer.byteLength(contents)}\n`;
    });
    const archive = path.join(root, "candidate.tgz");
    createTar(
      { cwd: packageRoot, file: archive, sync: true, gzip: true, portable: true },
      Object.keys(files),
    );
    vi.stubEnv("CRABLINE_CANDIDATE_ROOT", packageRoot);
    vi.stubEnv("CRABLINE_CANDIDATE_PACKAGE_SHA256", sha256(inventory.toSorted().join("")));
    vi.stubEnv("CRABLINE_CANDIDATE_ARCHIVE", archive);
    vi.stubEnv("CRABLINE_CANDIDATE_ARCHIVE_SHA256", sha256(fs.readFileSync(archive)));

    const { default: config } = await import("./vitest/vitest.crabline-candidate.config.ts");
    expect(discover(config.test, path.resolve(import.meta.dirname, ".."))).toEqual(candidateFiles);
  });
});
