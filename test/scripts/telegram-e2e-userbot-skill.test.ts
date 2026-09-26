import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";

const scriptsDir = path.resolve(".agents/skills/telegram-e2e-userbot/scripts");
const testNodeExecPath = resolveTestNodeExecPath();

function requireSuccess(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 120_000,
  });
  expect(result.error, `${result.stdout}${result.stderr}`).toBeUndefined();
  expect(`${result.stdout}${result.stderr}`).not.toContain("not ok");
  expect(result.status, `${command} ${args.join(" ")}\n${result.stdout}${result.stderr}`).toBe(0);
}

describe("repository Telegram E2E skill", () => {
  it("registers its UI metadata through the skill interface", () => {
    const descriptor = parse(
      fs.readFileSync(".agents/skills/telegram-e2e-userbot/agents/openai.yaml", "utf8"),
    );
    expect(Object.keys(descriptor)).toEqual(["interface"]);
    expect(descriptor.interface.default_prompt).toContain("$telegram-e2e-userbot");
  });

  it("passes its Node test suite", () => {
    const tests = fs
      .readdirSync(scriptsDir)
      .filter((entry) => entry.endsWith(".test.mjs"))
      .toSorted()
      .map((entry) => path.join(scriptsDir, entry));
    expect(tests.length).toBeGreaterThan(0);
    requireSuccess(testNodeExecPath, ["--test", ...tests]);
  });

  it.each(["pending", "exited"])("settles a %s triage fixture after readiness fails", (mode) => {
    const preload = new URL("../fixtures/triage-fixture-startup.mjs", import.meta.url);
    preload.searchParams.set("mode", mode);
    const result = spawnSync(
      testNodeExecPath,
      [
        "--import",
        preload.href,
        "--test",
        "--test-isolation=none",
        "--test-name-pattern=^emits interleaved visible and reasoning blocks$",
        path.join(scriptsDir, "triage-mock-openai.test.mjs"),
      ],
      { cwd: process.cwd(), encoding: "utf8", timeout: 120_000 },
    );
    const output = `${result.stdout}${result.stderr}`;
    expect(result.error, output).toBeUndefined();
    expect(result.status, output).toBe(1);
    expect(output).toContain("AssertionError");
    expect(output).toContain("mock-openai listening");
    expect(result.stderr).toContain(
      `triage-fixture-exited:${mode === "exited" ? "42" : "SIGTERM"}`,
    );
  });

  it("passes its Python test suite", () => {
    const tests = fs
      .readdirSync(scriptsDir)
      .filter((entry) => entry.endsWith(".test.py"))
      .toSorted();
    expect(tests.length).toBeGreaterThan(0);
    for (const test of tests) {
      requireSuccess("python3", [path.join(scriptsDir, test)]);
    }
  });
});
