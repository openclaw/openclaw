import { execFileSync } from "node:child_process";
import path from "node:path";

export function fixtureGit(
  root: string,
  env: NodeJS.ProcessEnv | ((args: readonly string[]) => NodeJS.ProcessEnv) = {},
) {
  return (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        `core.hooksPath=${path.join(root, "disabled-hooks")}`,
        "-c",
        "commit.gpgSign=false",
        "-C",
        root,
        ...args,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Doctor Fixture",
          GIT_AUTHOR_EMAIL: "doctor-fixture@example.invalid",
          GIT_COMMITTER_NAME: "Doctor Fixture",
          GIT_COMMITTER_EMAIL: "doctor-fixture@example.invalid",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
          ...(typeof env === "function" ? env(args) : env),
        },
      },
    ).trim();
}
