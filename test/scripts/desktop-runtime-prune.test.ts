import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { pruneDesktopRuntime } from "../../scripts/lib/desktop-runtime-prune.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temps = useAutoCleanupTempDirTracker(afterEach);

it("removes audited development files while preserving runtime data and every Markdown file", () => {
  const root = temps.make("desktop-prune-");
  const removed = [
    "openclaw/dist/plugin-sdk/index.d.ts",
    "openclaw/node_modules/dependency/index.d.mts",
    "openclaw/node_modules/dependency/index.d.cts.map",
    "@mistralai/mistralai/src/client.ts",
    "@mistralai/mistralai/tests/client.test.ts",
    "@mistralai/mistralai/examples/client.js",
    "@mistralai/mistralai/packages/mistralai-azure/examples/client.ts",
    "pino/benchmarks/run.js",
  ];
  const retained = [
    "openclaw/dist/index.mjs",
    "openclaw/dist/index.mjs.map",
    "openclaw/dist/control-ui/index.html.br",
    "openclaw/dist/extensions/plugin/assets/example.d.ts",
    "openclaw/extensions/plugin/node_modules/dependency/index.d.ts",
    "@mistralai/mistralai/esm/client.js",
    "@mistralai/mistralai/src/README.md",
    "@mistralai/mistralai/tests/nested/guide.MD",
    "@mistralai/mistralai/tests/LICENSE",
    "@mistralai/mistralai/examples/NOTICE.txt",
    "@mistralai/mistralai/examples/package.json",
    "unknown/src/index.ts",
    "unknown/__tests__/runtime.js",
    "unknown/example/runtime.js",
    "unknown/benchmark/runtime.js",
    "unknown/native.node",
    "unknown/asset.bin",
    "openai/src/index.ts",
    "pino/pino.js",
  ];
  for (const file of [...removed, ...retained]) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), file);
  }
  writeFileSync(
    path.join(root, "@mistralai/mistralai/package.json"),
    JSON.stringify({ name: "@mistralai/mistralai", version: "2.7.0" }),
  );
  writeFileSync(
    path.join(root, "openai/package.json"),
    JSON.stringify({ name: "openai", version: "999.0.0" }),
  );
  writeFileSync(
    path.join(root, "pino/package.json"),
    JSON.stringify({ name: "pino", version: "9.14.0", main: "pino.js" }),
  );
  const outside = temps.make("desktop-prune-outside-");
  writeFileSync(path.join(outside, "index.d.ts"), "outside");
  symlinkSync(outside, path.join(root, "linked-package"), "junction");

  expect(pruneDesktopRuntime(root).files).toBe(removed.length);
  for (const file of removed) {
    expect(existsSync(path.join(root, file)), file).toBe(false);
  }
  for (const file of retained) {
    expect(readFileSync(path.join(root, file), "utf8"), file).toBe(file);
  }
  expect(readFileSync(path.join(outside, "index.d.ts"), "utf8")).toBe("outside");
  expect(pruneDesktopRuntime(root)).toEqual({ files: 0, bytes: 0 });
});
