import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  readCiWorkflow,
  runWorkflowShellScript,
  type WorkflowStep,
  writeExecutable,
} from "./ci-workflow.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("installs WebKit only for the shard owning the selected workboard suite", () => {
  const step = readCiWorkflow().jobs["checks-ui-e2e"].steps.find(
    (candidate: WorkflowStep) => candidate.name === "Test Control UI end-to-end",
  );
  const root = tempDirs.make("openclaw-ui-browser-dependencies-");
  const bin = path.join(root, "bin");
  const installs = path.join(root, "installs");
  const args = path.join(root, "args");
  const include = path.join(root, "include.json");
  const suite = "ui/src/pages/workboard/workboard-native-bundle.e2e.test.ts";
  const sibling = "ui/src/e2e/sibling.e2e.test.ts";
  const fixture = (file: string, content: string) => {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  mkdirSync(bin);
  symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");
  for (const file of [suite, sibling]) {
    fixture(file, 'throw new Error("Discovery must not execute test bodies");\n');
  }
  const source = (file: string) => JSON.stringify(pathToFileURL(path.resolve(file)).href);
  fixture(
    "test/vitest/vitest.pattern-file.ts",
    `export * from ${source("test/vitest/vitest.pattern-file.ts")};\n`,
  );
  fixture(
    "test/vitest/vitest.ui-e2e.config.ts",
    `import { UiE2eSequencer } from ${source("test/vitest/vitest.ui-e2e.sequencer.ts")};
import { loadPatternListFromEnv } from "./vitest.pattern-file.ts";
export default { test: {
  include: loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE") ?? ["ui/src/**/*.e2e.test.ts"],
  maxWorkers: 2,
  sequence: { sequencer: UiE2eSequencer },
} };\n`,
  );
  writeExecutable(path.join(bin, "pnpm"), [
    "#!/bin/sh",
    'printf "%s\\n" "$*" >> "$UI_BROWSER_INSTALLS"',
  ]);
  writeExecutable(path.join(bin, "node"), [
    "#!/bin/sh",
    'printf "%s\\n" "$@" > "$UI_BROWSER_ARGS"',
  ]);
  writeFileSync(installs, "");
  const run = (index: number, patterns?: string[]) => {
    writeFileSync(include, JSON.stringify(patterns ?? []));
    const result = runWorkflowShellScript(step.run, {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: "",
        OPENCLAW_VITEST_INCLUDE_FILE: patterns ? include : "",
        OPENCLAW_VITEST_MAX_WORKERS: "3",
        VITEST_MAX_WORKERS: undefined,
        VITEST_SHARD_INDEX: String(index),
        VITEST_SHARD_COUNT: "2",
        UI_BROWSER_INSTALLS: installs,
        UI_BROWSER_ARGS: args,
      },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(readFileSync(args, "utf8").trim().split("\n")).toEqual([
      "scripts/run-vitest.mjs",
      "run",
      "--config",
      "test/vitest/vitest.ui-e2e.config.ts",
      "--configLoader",
      "runner",
      "--maxWorkers",
      "3",
      "--shard",
      `${index}/2`,
    ]);
  };
  run(1);
  run(2);
  expect(readFileSync(installs, "utf8").trim().split("\n")).toEqual([
    "--dir ui exec playwright install --with-deps webkit",
  ]);
  writeFileSync(installs, "");
  run(1, [sibling]);
  expect(readFileSync(installs, "utf8")).toBe("");
});
