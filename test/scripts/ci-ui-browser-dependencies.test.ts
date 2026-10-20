import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  readCiWorkflow,
  requiredWorkflowStep,
  runWorkflowShellScript,
  writeExecutable,
} from "./ci-workflow.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each([
  "ui/src/pages/workboard/workboard-native-bundle.e2e.test.ts",
  "ui/src/e2e/tooltip-first-activation.e2e.test.ts",
])("installs WebKit only for the shard owning %s", (suite) => {
  const step = requiredWorkflowStep(
    readCiWorkflow().jobs["checks-ui-e2e"].steps,
    "Test Control UI end-to-end",
  );
  const root = tempDirs.make("openclaw-ui-browser-dependencies-");
  const local = (file: string) => path.join(root, file);
  const [bin, installs, args, include] = [
    local("bin"),
    local("installs"),
    local("args"),
    local("include.json"),
  ];
  const sibling = "ui/src/e2e/sibling.e2e.test.ts";
  const fixture = (file: string, content: string) => {
    mkdirSync(path.dirname(local(file)), { recursive: true });
    writeFileSync(local(file), content);
  };
  mkdirSync(bin);
  symlinkSync(path.resolve("node_modules"), local("node_modules"), "junction");
  for (const file of [suite, sibling]) {
    fixture(file, 'throw new Error("Discovery must not execute test bodies");\n');
  }
  const source = (file: string) => JSON.stringify(pathToFileURL(path.resolve(file)).href);
  fixture(
    "test/vitest/vitest.ui-e2e.config.ts",
    `import { UiE2eSequencer } from ${source("test/vitest/vitest.ui-e2e.sequencer.ts")};
import { loadPatternListFromEnv } from ${source("test/vitest/vitest.pattern-file.ts")};
export default { test: {
  include: loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE") ?? ["ui/src/**/*.e2e.test.ts"],
  maxWorkers: 2, sequence: { sequencer: UiE2eSequencer },
} };\n`,
  );
  for (const [command, body] of [
    ["pnpm", 'printf "%s\\n" "$*" >> "$UI_BROWSER_INSTALLS"'],
    ["node", 'printf "%s\\n" "$@" > "$UI_BROWSER_ARGS"'],
  ] as const) {
    writeExecutable(path.join(bin, command), ["#!/bin/sh", body]);
  }
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
    expect(result, result.stdout + result.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(readFileSync(args, "utf8")).toBe(
      `scripts/run-vitest.mjs run --config test/vitest/vitest.ui-e2e.config.ts --configLoader runner --maxWorkers 3 --shard ${index}/2\n`.replaceAll(
        " ",
        "\n",
      ),
    );
  };
  run(1);
  run(2);
  expect(readFileSync(installs, "utf8")).toBe(
    "--dir ui exec playwright install --with-deps webkit\n",
  );
  writeFileSync(installs, "");
  run(1, [sibling]);
  expect(readFileSync(installs, "utf8")).toBe("");
});
