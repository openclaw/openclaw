import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { restoreNativeRuntime } from "../../scripts/macos-native-runtime-artifact.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  readCiWorkflow,
  requiredWorkflowStep,
  runWorkflowShellScript,
} from "./ci-workflow.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each([
  { requested: "true", capable: true, recovery: true },
  { requested: "true", capable: false, recovery: false },
  { requested: "false", capable: true, recovery: false },
])("transfers only the selected native runtime output: %j", ({ requested, capable, recovery }) => {
  const root = tempDirs.make("macos-recovery-runtime-");
  const source = path.join(root, "source");
  const restored = path.join(root, "restored");
  const archive = path.join(source, ".artifacts/macos-native-runtime");
  const revision = "a".repeat(40);
  const core = {
    "dist/build-info.json": JSON.stringify({ commit: revision }),
    "packages/ai/dist/index.js": "portable AI runtime",
  };
  const expanded = {
    "dist/control-ui/index.html": "portable UI",
    "dist/extensions/codex/index.js": "portable plugin",
    "dist/worker/fs-safe-darwin-arm64.node": "pinned Darwin worker asset, not Linux dependency",
    "dist-runtime/extensions/codex/index.js": "portable overlay",
  };
  for (const [file, content] of Object.entries({
    ...core,
    ...expanded,
    "node_modules/linux-only.node": "host dependency",
    "dist/extensions/node_modules/linux-only.node": "host dependency",
    "scripts/macos-native-runtime-artifact.mjs": capable
      ? "native-runtime-bundled-recovery-v1"
      : "historical",
  })) {
    mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    writeFileSync(path.join(source, file), content);
  }
  mkdirSync(path.join(source, ".ci-harness/scripts"), { recursive: true });
  copyFileSync(
    new URL("../../scripts/macos-native-runtime-artifact.mjs", import.meta.url),
    path.join(source, ".ci-harness/scripts/macos-native-runtime-artifact.mjs"),
  );
  const output = path.join(root, "output");
  const producer = requiredWorkflowStep(
    readCiWorkflow().jobs["build-artifacts"].steps,
    "Package runtime for native policy tests",
  );
  const result = runWorkflowShellScript(producer.run, {
    cwd: source,
    env: {
      ...process.env,
      BUNDLED_RECOVERY: requested,
      TARGET_SHA: revision,
      GITHUB_OUTPUT: output,
    },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(output, "utf8").trim()).toBe(`bundled-recovery=${recovery}`);
  mkdirSync(restored);
  restoreNativeRuntime(restored, archive, revision);
  for (const [file, content] of Object.entries(core)) {
    expect(readFileSync(path.join(restored, file), "utf8"), file).toBe(content);
  }
  for (const [file, content] of Object.entries(expanded)) {
    expect(existsSync(path.join(restored, file)), file).toBe(recovery);
    if (recovery) {
      expect(readFileSync(path.join(restored, file), "utf8"), file).toBe(content);
    }
  }
  const entries = execFileSync("tar", ["-tzf", path.join(archive, "runtime.tgz")], {
    encoding: "utf8",
  });
  expect(entries).not.toContain("node_modules");
  expect(() => restoreNativeRuntime(restored, archive, "b".repeat(40))).toThrow(
    "Native test runtime must match the selected checkout",
  );
  expect(() => restoreNativeRuntime(restored, path.join(root, "missing"), revision)).toThrow();
});
