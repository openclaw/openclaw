import { execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { countSessionIdentityPins, main } from "../../scripts/check-session-identity-ratchet.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";
import { fixtureFiles } from "./script-fixture-files.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("distinguishes absent IDs from comparisons with another identity", () => {
  const cases: [string, number][] = [
    ["target.sessionId !== undefined", 0],
    ["undefined !== target.sessionId", 0],
    ["target.sessionId === null", 0],
    ["null === target.sessionId", 0],
    ["target.sessionId !== undefined && previous.sessionId === target.sessionId", 2],
    ["target.sessionId === undefinedId", 1],
    ["target.sessionId === value.undefined", 1],
    ["value.undefined === target.sessionId", 1],
    ["target.sessionId === undefined.sessionId", 2],
    ["expectedSessionId !== undefined", 1],
    ["generation !== undefined && generation !== captured", 1],
    ['throw new Error("session was replaced")', 1],
  ];
  for (const [source, expected] of cases) {
    expect(countSessionIdentityPins(source), source).toBe(expected);
  }
});

it("accepts a presence guard without allowing additional identity comparisons", () => {
  const root = tempDirs.make("openclaw-session-identity-");
  const { write } = fixtureFiles(root);
  const sourcePath = "src/feature/example.ts";
  const comparison = "previous.sessionId === target.sessionId";
  write(sourcePath, "export const matches = " + comparison + ";\n");
  write("config/session-identity-allowlist.txt", sourcePath + "\t2\n");
  for (const args of [["init"], ["add", "."], ["commit", "-m", "fixture"]]) {
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: root,
      env: createNestedGitEnv(),
      stdio: "ignore",
    });
  }
  vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  write(
    sourcePath,
    "export const matches = target.sessionId !== undefined && " + comparison + ";\n",
  );
  const result = main(root, ["--base", "HEAD"]);
  expect(result, JSON.stringify(errors.mock.calls)).toBe(0);
  expect(errors).not.toHaveBeenCalled();
  write(
    sourcePath,
    "export const matches = target.sessionId !== undefined && " +
      comparison +
      " && target.sessionId !== other;\n",
  );
  expect(main(root, ["--base", "HEAD"])).toBe(1);
  expect(errors).toHaveBeenCalledWith(expect.stringContaining("src/feature/example.ts: 3 > 2"));
});
