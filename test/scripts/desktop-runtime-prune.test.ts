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
    "@anthropic-ai/sdk/src/client.ts",
    "pino/test/client.test.ts",
    "pino/examples/client.js",
    "pino/test/nested/client.ts",
    "pino/benchmarks/run.js",
  ];
  const retained = [
    "openclaw/dist/index.mjs",
    "openclaw/dist/index.mjs.map",
    "openclaw/dist/control-ui/index.html.br",
    "openclaw/dist/extensions/plugin/assets/example.d.ts",
    "openclaw/extensions/plugin/node_modules/dependency/index.d.ts",
    "@anthropic-ai/sdk/client.js",
    "@anthropic-ai/sdk/src/README.md",
    "pino/test/nested/guide.MD",
    "pino/test/LICENSE",
    "pino/examples/NOTICE.txt",
    "pino/examples/package.json",
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
    path.join(root, "@anthropic-ai/sdk/package.json"),
    JSON.stringify({ name: "@anthropic-ai/sdk", version: "0.132.1" }),
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
