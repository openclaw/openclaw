import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  countTestTimeoutRaceReferences,
  main,
} from "../../scripts/check-test-timeout-race-ratchet.mts";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";
import { parseRatchetCounts } from "../../scripts/lib/shrink-ratchet.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function git(cwd: string, args: string[]) {
  execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args], {
    cwd,
    env: createNestedGitEnv(),
    stdio: "ignore",
  });
}

describe("check-test-timeout-race-ratchet", () => {
  it("counts references and imported aliases without counting import specifiers or text", () => {
    using parser = createNativeTypeScriptParser();
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
      expect(
        countTestTimeoutRaceReferences(
          "fixture.ts",
          parser.parseSourceFile("fixture.ts", source),
          parser,
        ),
        source,
      ).toBe(expected);
    }
    expect(() =>
      countTestTimeoutRaceReferences(
        "broken.ts",
        parser.parseSourceFile("broken.ts", "withTestTimeout("),
        parser,
      ),
    ).toThrow(/^broken.ts:1: /u);
  });

  it("blocks added sites, reads the index, ignores the owner, and demands shrinking removed sites", () => {
    const root = tempDirs.make("openclaw-test-timeout-race-");
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.mkdirSync(path.join(root, "test/helpers"), { recursive: true });
    const baselinePath = path.join(root, "config/test-timeout-race-baseline.txt");
    const sourcePath = path.join(root, "test/example.test.ts");
    const original = "withTestTimeout(work, 100);\n";
    fs.writeFileSync(baselinePath, "test/example.test.ts\t1\n");
    fs.writeFileSync(sourcePath, original);
    fs.writeFileSync(
      path.join(root, "test/helpers/promise.ts"),
      "export function withTestTimeout() {}\n",
    );
    fs.writeFileSync(
      path.join(root, "test/example.d.ts"),
      "declare function withTestTimeout(): void;\n",
    );
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
});
