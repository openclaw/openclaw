import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type GuardRequest = {
  method: string;
  path: string;
  delay?: number;
  body?: { context?: string; state?: string; body?: string; labels?: string[] };
};

export function runGuardFixture(options: {
  root: string;
  script: string;
  event: object;
  routes: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  captureOutput?: boolean;
}) {
  const files = Object.fromEntries(
    ["event", "fixture", "requests", "environment", "output"].map((name) => [
      name,
      join(options.root, name),
    ]),
  );
  writeFileSync(files.event!, JSON.stringify(options.event));
  writeFileSync(
    files.fixture!,
    JSON.stringify({ routes: options.routes, logPath: files.requests, clock: true }),
  );
  for (const name of ["requests", "environment", "output"]) {
    writeFileSync(files[name]!, "");
  }
  const result = spawnSync(
    process.execPath,
    ["--import", resolve("test/fixtures/github-guard-fetch.mjs"), options.script],
    {
      encoding: "utf8",
      env: {
        GITHUB_TOKEN: "fixture-token",
        GITHUB_EVENT_PATH: files.event,
        ...(options.captureOutput
          ? { GITHUB_ENV: files.environment, GITHUB_OUTPUT: files.output }
          : {}),
        GITHUB_REPOSITORY: "openclaw/openclaw",
        GITHUB_RUN_ID: "123",
        OPENCLAW_GUARD_TEST_FIXTURE: files.fixture,
        ...options.env,
      },
    },
  );
  return {
    ...result,
    environment: readFileSync(files.environment!, "utf8"),
    output: readFileSync(files.output!, "utf8"),
    requests: readFileSync(files.requests!, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as GuardRequest),
  };
}
