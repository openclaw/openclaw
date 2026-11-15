import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { API } from "typescript/sync";
import { afterEach, expect, it, vi } from "vitest";
import {
  countTestTimeoutRaceReferences,
  main,
} from "../../scripts/check-test-timeout-race-ratchet.mts";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";
import { parseRatchetCounts } from "../../scripts/lib/shrink-ratchet.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";
import { fixtureFiles } from "./script-fixture-files.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function git(cwd: string, args: string[]) {
  const gitArgs = ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args];
  execFileSync("git", gitArgs, { cwd, env: createNestedGitEnv(), stdio: "ignore" });
}

it("counts references and imported aliases without counting import specifiers or text", () => {
  using parser = createNativeTypeScriptParser();
  const count = (source: string, file = "fixture.ts") =>
    countTestTimeoutRaceReferences(file, parser.parseSourceFile(file, source), parser);
  const cases: [string, number][] = [
    ["withTestTimeout(work, 100); raceWithTimeoutResult(work, 100, null);", 2],
    ["withTestTimeout<string>(work, 100);", 1],
    ["testPromises.withTestTimeout(work, 100);", 1],
    ['import { withTestTimeout as race } from "./promise.js"; race(work, 100);', 1],
    ['import { raceWithTimeoutResult as race } from "./promise.js"; race(work, 100);', 1],
    ["function raceWithTimeoutResult() {} raceWithTimeoutResult();", 2],
    ['export { withTestTimeout, raceWithTimeoutResult as race } from "./promise.js";', 2],
    ["const withTestTimeout = testPromises.withTestTimeout; const race = withTestTimeout;", 3],
    ['// withTestTimeout(work)\nconst text = "raceWithTimeoutResult(work)";', 0],
    ['import { withTestTimeout, raceWithTimeoutResult as race } from "./promise.js";', 0],
  ];
  for (const [source, expected] of cases) {
    expect(count(source), source).toBe(expected);
  }
  expect(() => count("withTestTimeout(", "broken.ts")).toThrow(/^broken.ts:1: /u);
});

it.each([0, 1, 32, 33])("bounds native snapshot preparation for %i candidate files", (size) => {
  const root = tempDirs.make("openclaw-timeout-batch-");
  const { write } = fixtureFiles(root);
  const entries = Array.from(
    { length: size },
    (_, index) => `test/${String(index).padStart(2, "0")}.ts`,
  );
  for (const [index, file] of entries.entries()) {
    write(
      file,
      index === 0
        ? "// withTestTimeout(work)\n"
        : 'import { withTestTimeout as race } from "./promise.js"; race(work);\n',
    );
  }
  write(
    "config/test-timeout-race-baseline.txt",
    entries
      .slice(1)
      .map((file) => `${file}\t1\n`)
      .join(""),
  );
  for (const args of [["init"], ["add", "."], ["commit", "-m", "base"]]) {
    git(root, args);
  }
  const calls = { createSnapshot: 0, updateSnapshot: 0 };
  const descriptors = (["createSnapshot", "updateSnapshot"] as const).map((name) => ({
    name,
    descriptor: Object.getOwnPropertyDescriptor(API.prototype, name)!,
  }));
  try {
    for (const { name, descriptor } of descriptors) {
      Object.defineProperty(API.prototype, name, {
        ...descriptor,
        get(this: API) {
          const invoke: API[typeof name] = descriptor.get!.call(this);
          const counted = new Proxy(invoke, {
            apply(target, receiver, args) {
              calls[name] += 1;
              return Reflect.apply(target, receiver, args);
            },
          });
          // The SDK getter caches its callable on the instance; count subsequent calls too.
          Object.defineProperty(this, name, { configurable: true, value: counted });
          return counted;
        },
      });
    }
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(main(root, ["--base", "HEAD"])).toBe(0);
    const positive = Math.max(0, size - 1);
    expect(output.mock.calls).toEqual([
      [`test timeout race ratchet OK: ${positive} files, ${positive} grandfathered sites.`],
    ]);
    expect(errors).not.toHaveBeenCalled();
    expect(calls).toEqual({
      createSnapshot: Number(size > 0),
      updateSnapshot: Math.max(0, Math.ceil(size / 32) - 1),
    });
    if (size > 1) {
      const file = entries[1]!;
      const original = fs.readFileSync(path.join(root, file), "utf8");
      write(file, original + "race(work);\n");
      calls.createSnapshot = calls.updateSnapshot = 0;
      expect(main(root, ["--base", "HEAD"])).toBe(1);
      expect(errors).toHaveBeenNthCalledWith(
        1,
        `Wall-clock test timeout races exceed the grandfathered per-file baseline:\n  ${file}: 2 > 1`,
      );
      expect(errors).toHaveBeenCalledTimes(2);
      expect(calls).toEqual({ createSnapshot: 1, updateSnapshot: Math.ceil(size / 32) });
      write(file, original);
      errors.mockClear();
    }
    if (size === 33) {
      write(entries[0]!, "withTestTimeout(\n");
      write(entries[32]!, "raceWithTimeoutResult(\n");
      calls.createSnapshot = calls.updateSnapshot = 0;
      expect(main(root, ["--base", "HEAD"])).toBe(1);
      expect(errors.mock.calls).toEqual([[expect.stringMatching(/^test\/00.ts:2: /u)]]);
      expect(calls).toEqual({ createSnapshot: 1, updateSnapshot: 0 });
    }
  } finally {
    for (const { name, descriptor } of descriptors) {
      Object.defineProperty(API.prototype, name, descriptor);
    }
  }
});

it("blocks added sites, reads the index, ignores the owner, and demands shrinking removed sites", () => {
  const root = tempDirs.make("openclaw-test-timeout-race-");
  const { write } = fixtureFiles(root);
  const baselinePath = path.join(root, "config/test-timeout-race-baseline.txt");
  const sourcePath = path.join(root, "test/example.test.ts");
  const original = "withTestTimeout(work, 100);\n";
  write("config/test-timeout-race-baseline.txt", "test/example.test.ts\t1\n");
  write("test/example.test.ts", original);
  write("test/helpers/promise.ts", "export function withTestTimeout() {}\n");
  write("test/example.d.ts", "declare function withTestTimeout(): void;\n");
  for (const args of [["init"], ["add", "."], ["commit", "-m", "base"]]) {
    git(root, args);
  }
  const errors: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args.join(" ")));
  vi.spyOn(console, "log").mockImplementation(() => {});
  expect(main(root, ["--base", "HEAD"])).toBe(0);

  fs.appendFileSync(sourcePath, "raceWithTimeoutResult(work, 100, null);\n");
  expect(main(root, ["--base", "HEAD"])).toBe(1);
  expect(errors.join("\n")).toContain("test/example.test.ts: 2 > 1");
  expect(errors.join("\n")).toContain("awaitGateBeforeSettlement");
  expect(errors.join("\n")).toContain("withinTest");
  expect(main(root, ["--staged"])).toBe(0);
  git(root, ["add", "test/example.test.ts"]);
  fs.writeFileSync(sourcePath, original);
  expect(main(root, ["--staged"])).toBe(1);
  git(root, ["add", "test/example.test.ts"]);

  const addedPath = path.join(root, "test/new.test.js");
  fs.writeFileSync(addedPath, "withTestTimeout(work, 100);\n");
  errors.length = 0;
  expect(main(root, ["--base", "HEAD"])).toBe(1);
  expect(errors.join("\n")).toContain("test/new.test.js: 1 > 0");
  fs.unlinkSync(addedPath);

  fs.writeFileSync(sourcePath, "export {};\n");
  errors.length = 0;
  expect(main(root, ["--base", "HEAD"])).toBe(1);
  expect(errors.join("\n")).toContain(
    "Shrink config/test-timeout-race-baseline.txt entries (or run with --prune):",
  );
  expect(main(root, ["--base", "HEAD", "--prune"])).toBe(0);
  expect(parseRatchetCounts(fs.readFileSync(baselinePath, "utf8"), baselinePath)).toEqual(
    new Map(),
  );
  expect(main(root, ["--base", "HEAD"])).toBe(0);
});
