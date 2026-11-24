import { afterEach, expect, it } from "vitest";
import { resolveChangedNodeTestTargets } from "../../scripts/lib/ci-changed-node-test-plan.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  createChangedNodeTestShards,
  selectedFiles,
  writeFiles,
} from "./ci-changed-node-test-plan.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const catalog = "extensions/qa-lab/src/scenario-catalog.test.ts";
const uiInventory = "test/vitest-ui-package-config.test.ts";

it("selects the UI runtime inventory when a test is removed or renamed", () => {
  const cwd = tempDirs.make("ci-deleted-ui-selection-");
  writeFiles(cwd, [catalog, uiInventory, "ui/src/pages/chat/new.browser.test.ts"]);
  for (const changedPaths of [
    ["ui/src/pages/chat/components/chat-swarm-progress.browser.test.ts"],
    [
      "ui/src/pages/chat/components/chat-swarm-progress.browser.test.ts",
      "ui/src/pages/chat/new.browser.test.ts",
    ],
  ]) {
    expect(
      resolveChangedNodeTestTargets(changedPaths, { cwd, selectionMode: "aggressive" }),
    ).toContain(uiInventory);
  }
  expect(
    resolveChangedNodeTestTargets(["ui/src/pages/chat/new.browser.test.ts"], {
      cwd,
      selectionMode: "aggressive",
    }),
  ).not.toContain(uiInventory);
});

it("selects the QA reference check for removed paths, including the old side of renames", () => {
  const cwd = tempDirs.make("ci-qa-catalog-selection-");
  writeFiles(cwd, [catalog, "extensions/openai/src/responses-stream.runtime.ts"]);
  for (const changedPaths of [
    ["extensions/openai/native-web-search.ts"],
    ["extensions/openai/native-web-search.ts", "extensions/openai/src/responses-stream.runtime.ts"],
    ["src/agents/retired.ts"],
    ["test/retired.test.ts"],
    ["docs/retired.md"],
  ]) {
    const shards = createChangedNodeTestShards(changedPaths, {
      cwd,
      selectionMode: "aggressive",
      includePrExemptRuntimeTests: false,
    });
    expect(shards, changedPaths.join(", ")).not.toBeNull();
    expect(selectedFiles(shards), changedPaths.join(", ")).toContain(catalog);
    expect(shards?.some((shard) => shard.requiresDist)).toBe(false);
  }
});

it("does not add the QA reference check for existing unrelated paths", () => {
  const cwd = tempDirs.make("ci-qa-catalog-selection-");
  writeFiles(cwd, {
    [catalog]: "export {};\n",
    "src/example/runtime.ts": "export {};\n",
    "docs/guide.md": "# Guide\n",
  });
  for (const changedPaths of [["src/example/runtime.ts"], ["docs/guide.md"]]) {
    expect(
      selectedFiles(
        createChangedNodeTestShards(changedPaths, { cwd, selectionMode: "aggressive" }),
      ),
    ).not.toContain(catalog);
  }
});
