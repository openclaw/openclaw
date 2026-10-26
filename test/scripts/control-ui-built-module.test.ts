import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const provided = vi.hoisted(() => ({ buildRoot: undefined as string | undefined }));
vi.mock("vitest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vitest")>()),
  inject: () => provided.buildRoot,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  provided.buildRoot = undefined;
  vi.restoreAllMocks();
});

function buildFixture() {
  const root = tempDirs.make("control-ui-built-module-");
  fs.mkdirSync(path.join(root, "assets"));
  return root;
}

function writeMap(root: string, name: string, sources: string[]) {
  const file = path.join(root, "assets", name);
  fs.writeFileSync(file, JSON.stringify({ version: 3, sources, names: [], mappings: "" }));
  return file;
}

it("lazily reuses default metadata across distinct module lookups and matching errors", async () => {
  const root = buildFixture();
  provided.buildRoot = root;
  const { controlUiE2eBuiltModuleRequest: resolve } =
    await import("../../ui/src/e2e/control-ui-built-module.test-support.ts");
  const fixtureMaps = new Set([
    writeMap(root, "first.[one]+.js.map", [
      "C:\\build\\ui\\src\\first.ts",
      "C:\\build\\ui\\src\\first.ts",
      "../../ui/src/shared.ts",
    ]),
    writeMap(root, "second.js.map", ["../../ui/src/second.ts", "../../ui/src/shared.ts"]),
  ]);
  fs.writeFileSync(path.join(root, "assets", "style.css.map"), "not a JavaScript map");

  const first = resolve("ui\\src\\first.ts");
  expect(first.test("/assets/first.[one]+.js?version=1")).toBe(true);
  expect(first.test("/assets/firstXo.js")).toBe(false);
  // Every later lookup must use the first complete catalog, without rereading maps.
  for (const file of fixtureMaps) {
    fs.writeFileSync(file, "{");
  }
  expect(resolve("ui/src/second.ts").test("/assets/second.js")).toBe(true);
  expect(() => resolve("ui/src/missing.ts")).toThrow(
    "Expected one built chunk for ui/src/missing.ts, found 0",
  );
  expect(() => resolve("ui/src/shared.ts")).toThrow(
    "Expected one built chunk for ui/src/shared.ts, found 2",
  );
});

it("rereads explicit roots without priming the default catalog and keys defaults by root", async () => {
  const root = buildFixture();
  const beforeMap = writeMap(root, "before.js.map", ["../../ui/src/before.ts"]);
  const { controlUiE2eBuiltModuleRequest: resolve } =
    await import("../../ui/src/e2e/control-ui-built-module.test-support.ts");
  expect(resolve("ui/src/before.ts", root).test("/assets/before.js")).toBe(true);

  fs.unlinkSync(beforeMap);
  const afterMap = writeMap(root, "after.js.map", ["../../ui/src/after.ts"]);
  expect(resolve("ui/src/after.ts", root).test("/assets/after.js")).toBe(true);
  expect(() => resolve("ui/src/before.ts", root)).toThrow(
    "Expected one built chunk for ui/src/before.ts, found 0",
  );

  fs.unlinkSync(afterMap);
  writeMap(root, "default.js.map", ["../../ui/src/current.ts"]);
  provided.buildRoot = root;
  expect(resolve("ui/src/current.ts").test("/assets/default.js")).toBe(true);

  const otherRoot = buildFixture();
  writeMap(otherRoot, "other.js.map", ["../../ui/src/current.ts"]);
  provided.buildRoot = otherRoot;
  expect(resolve("ui/src/current.ts").test("/assets/other.js")).toBe(true);
  provided.buildRoot = root;
  expect(resolve("ui/src/current.ts").test("/assets/default.js")).toBe(true);
});

it("does not publish a partial catalog after a malformed map and retries the corrected build", async () => {
  const root = buildFixture();
  writeMap(root, "a.js.map", ["../../ui/src/original.ts"]);
  const brokenMap = path.join(root, "assets", "z.js.map");
  fs.writeFileSync(brokenMap, "{");
  provided.buildRoot = root;
  const { controlUiE2eBuiltModuleRequest: resolve } =
    await import("../../ui/src/e2e/control-ui-built-module.test-support.ts");
  expect(() => resolve("ui/src/original.ts")).toThrow(SyntaxError);

  writeMap(root, "a.js.map", ["../../ui/src/corrected.ts"]);
  writeMap(root, "z.js.map", ["../../ui/src/repaired.ts"]);
  expect(resolve("ui/src/corrected.ts").test("/assets/a.js")).toBe(true);
  expect(resolve("ui/src/repaired.ts").test("/assets/z.js")).toBe(true);
  expect(() => resolve("ui/src/original.ts")).toThrow(
    "Expected one built chunk for ui/src/original.ts, found 0",
  );

  provided.buildRoot = undefined;
  expect(() => resolve("ui/src/corrected.ts")).toThrow(
    "Built Control UI requests require the bundled Control UI E2E server",
  );
});
