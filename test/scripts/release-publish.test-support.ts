import { execFileSync } from "node:child_process";
import { expect } from "vitest";
import { createNestedGitEnv } from "../helpers/temp-repo.js";

export function fixtureGit(cwd: string, name: string, email: string, noHooks = false) {
  return (...args: string[]) =>
    execFileSync(
      "git",
      [
        ...(noHooks ? ["-c", "core.hooksPath=/dev/null"] : []),
        "-c",
        "commit.gpgsign=false",
        "-c",
        `user.name=${name}`,
        "-c",
        `user.email=${email}`,
        ...args,
      ],
      { cwd, env: createNestedGitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
}

export function expectGate(rows: unknown, fields: Record<string, unknown>) {
  expect(rows).toContainEqual(expect.objectContaining(fields));
}
