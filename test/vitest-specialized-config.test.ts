import fs from "node:fs";
import path from "node:path";
import { globSync } from "tinyglobby";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import type { TestUserConfig } from "vitest/config";
import { resolveConfig } from "vitest/node";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";
import { createE2EVitestConfig } from "./vitest/vitest.e2e.config.ts";
import liveConfig from "./vitest/vitest.live.config.ts";
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

function discover(
  test: Pick<TestUserConfig, "include" | "exclude"> | undefined,
  cwd: string,
): string[] {
  assert(test?.include, "Expected an explicit test inventory");
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
    async (selection) => {
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
      for (const file of ordinary) {
        fs.writeFileSync(
          path.join(root, file),
          'import fs from "node:fs"; import { expect, it } from "vitest"; it("reads its source", () => expect(fs.readFileSync(import.meta.filename, "utf8")).toContain("reads its source"));',
        );
      }
      const includeFile = path.join(root, "include.json");
      fs.writeFileSync(
        includeFile,
        JSON.stringify(selection === "directory" ? ["test/**/*.test.*"] : files),
      );
      const config = createToolingVitestConfig({ OPENCLAW_VITEST_INCLUDE_FILE: includeFile });

      const { test } = await resolveConfig({ config: false, root, dir: root }, config);
      expect(test.dir).toBe(root);
      expect(discover(test, test.dir || test.root)).toEqual(ordinary);
    },
  );

  it("preserves dedicated E2E, live, and TUI inventories", async () => {
    const root = tempDirs.make("openclaw-specialized-owners-");
    const tuiFile = tuiPtyTestFiles[0]!;
    writeTestFiles(root, ["test/example.e2e.test.ts", "test/example.live.test.ts", tuiFile]);
    const includeFile = path.join(root, "include.json");
    fs.writeFileSync(includeFile, JSON.stringify([tuiFile]));
    const tuiConfig = createTuiPtyVitestConfig({ OPENCLAW_VITEST_INCLUDE_FILE: includeFile });

    expect(discover(createE2EVitestConfig({}).test, root)).toEqual(["test/example.e2e.test.ts"]);
    expect(discover(liveConfig.test, root)).toEqual(["test/example.live.test.ts"]);
    expect(
      discover(
        (await resolveConfig({ config: false, root, dir: path.join(root, "src") }, tuiConfig)).test,
        path.join(root, "src"),
      ),
    ).toEqual([tuiFile.replace(/^src\//u, "")]);
  });

  it("preserves each Control UI E2E project inventory", async () => {
    const root = tempDirs.make("openclaw-specialized-ui-");
    const files = [
      "ui/src/e2e/example.e2e.test.ts",
      "ui/src/e2e/board-fixture.e2e.test.ts",
      "ui/src/e2e/chat-stream-runtime-budgets.e2e.test.ts",
      "ui/src/e2e/agent-file-lifecycle.real-gateway.e2e.test.ts",
    ];
    writeTestFiles(root, files);
    const config = createUiE2eVitestConfig({}, ["node", "vitest", "run"]);

    const projects = await Promise.all(
      (config.test?.projects ?? []).map(async (candidate) => {
        const project = await candidate;
        if (!project || typeof project !== "object" || !("test" in project)) {
          throw new Error("Expected an inline Control UI project");
        }
        return { ...project, test: { ...project.test, root, dir: root } };
      }),
    );
    config.test = { ...config.test, projects };
    const resolved = await resolveConfig({ config: false, root, dir: root }, config);
    expect(discover(resolved.test, resolved.test.dir || resolved.test.root)).toEqual(
      files.toSorted(),
    );
    expect(
      resolved.test.resolvedProjects.map(({ projectConfig }) => ({
        name: projectConfig.name,
        files: discover(projectConfig, projectConfig.dir || projectConfig.root),
      })),
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
});
