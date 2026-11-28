import { execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { countSessionIdentityPins, main } from "../../scripts/check-session-identity-ratchet.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";
import { fixtureFiles } from "./script-fixture-files.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("distinguishes ID presence and type checks from identity comparisons", () => {
  const cases: [string, number][] = [
    ["target.sessionId !== undefined", 0],
    ["undefined !== target.sessionId", 0],
    ["target.sessionId === null", 0],
    ["null === target.sessionId", 0],
    ['typeof entry.sessionId === "string"', 0],
    ['typeof origin.runId !== "string"', 0],
    ["typeof target.generation === 'number'", 0],
    ['typeof target.sessionId === "string" && previous.sessionId === target.sessionId', 2],
    ['typeof target.sessionId === "identity"', 1],
    ['typeof expectedSessionId === "string"', 1],
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

it.each([30, 10])("funds the capped custody transfer from %s actual base pins", (baseCount) => {
  const root = tempDirs.make("openclaw-session-transfer-");
  const { write } = fixtureFiles(root);
  const caller = "src/agents/subagents/registry/subagent-registry-requester-yield.ts";
  const owner = "src/agents/subagents/registry/subagent-requester-turn-custody.ts";
  const unrelated = "src/feature/unrelated.ts";
  const baseline = "config/session-identity-allowlist.txt";
  const comparison = "entry.requesterTurnRunId === runId;\n";
  write(caller, comparison.repeat(baseCount / 2));
  write(owner, "export {};\n");
  write(unrelated, "export {};\n");
  write(baseline, `${caller}\t30\n`);
  for (const args of [["init"], ["add", "."], ["commit", "-m", "fixture"]]) {
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: root,
      env: createNestedGitEnv(),
      stdio: "ignore",
    });
  }
  vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  write(caller, comparison.repeat(5));
  write(owner, comparison);
  write(baseline, `${caller}\t10\n${owner}\t2\n`);
  expect(main(root, ["--base", "HEAD"]), JSON.stringify(errors.mock.calls)).toBe(
    baseCount === 30 ? 0 : 1,
  );
  if (baseCount === 30) {
    expect(errors).not.toHaveBeenCalled();
  } else {
    expect(errors).toHaveBeenCalledWith(expect.stringContaining(`${owner}: 2 > 0`));
  }

  errors.mockClear();
  write(caller, comparison.repeat(15));
  expect(main(root, ["--base", "HEAD"])).toBe(1);
  expect(errors).toHaveBeenCalledWith(expect.stringContaining(`${owner}: 2 > 0`));
  write(caller, comparison.repeat(5));

  errors.mockClear();
  write(owner, comparison.repeat(2));
  write(baseline, `${caller}\t10\n${owner}\t4\n`);
  expect(main(root, ["--base", "HEAD"])).toBe(1);
  expect(errors).toHaveBeenCalledWith(
    expect.stringContaining(`${owner}: 4 > ${baseCount === 30 ? 2 : 0}`),
  );

  write(owner, comparison);
  for (const callerCount of [28, 30]) {
    errors.mockClear();
    write(caller, comparison.repeat(callerCount / 2));
    write(baseline, `${caller}\t${callerCount}\n${owner}\t2\n`);
    expect(main(root, ["--base", "HEAD"])).toBe(1);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining(`${owner}: 2 > 0`));
  }

  write(caller, comparison.repeat(5));
  errors.mockClear();
  write(unrelated, comparison);
  write(baseline, `${caller}\t10\n${owner}\t2\n${unrelated}\t2\n`);
  expect(main(root, ["--base", "HEAD"])).toBe(1);
  expect(errors).toHaveBeenCalledWith(expect.stringContaining(`${unrelated}: 2 > 0`));
});

it("funds transfers only from pins removed at verified rename destinations", () => {
  const root = tempDirs.make("openclaw-session-transfer-rename-");
  const { write } = fixtureFiles(root);
  const caller = "src/feature/old-reader.ts";
  const renamed = "src/feature/new-reader.ts";
  const unchanged = "src/feature/other-reader.ts";
  const owner = "src/agents/subagents/registry/subagent-requester-turn-custody.ts";
  const baseline = "config/session-identity-allowlist.txt";
  const comparison = "entry.requesterTurnRunId === runId;\n";
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: root,
      env: createNestedGitEnv(),
      stdio: "ignore",
    });
  write(caller, comparison.repeat(5));
  write(unchanged, comparison.repeat(3));
  write(owner, "export {};\n");
  write(baseline, `${caller}\t10\n${unchanged}\t6\n`);
  git("init");
  git("add", ".");
  git("commit", "-m", "fixture");
  git("mv", caller, renamed);
  vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});

  write(baseline, `${renamed}\t10\n${unchanged}\t6\n`);
  expect(main(root, ["--base", "HEAD"]), JSON.stringify(errors.mock.calls)).toBe(0);
  expect(errors).not.toHaveBeenCalled();

  write(owner, comparison);
  write(baseline, `${renamed}\t10\n${unchanged}\t2\n${owner}\t2\n`);
  expect(main(root, ["--base", "HEAD"])).toBe(1);
  expect(errors).toHaveBeenCalledWith(expect.stringContaining(`${owner}: 2 > 0`));

  errors.mockClear();
  write(renamed, comparison.repeat(3));
  write(baseline, `${renamed}\t6\n${unchanged}\t6\n${owner}\t2\n`);
  expect(main(root, ["--base", "HEAD"]), JSON.stringify(errors.mock.calls)).toBe(0);
  expect(errors).not.toHaveBeenCalled();
});
