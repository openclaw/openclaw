import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";

type CorpusScenario = { cpus: number; slots: number; frozenTarget: boolean; fail?: string };
type ShellRunner = (
  script: string,
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => { status: number | null; stdout: string; stderr: string };

export function assertStartupCorpusCommand(
  script: string,
  directory: string,
  scenario: CorpusScenario,
  runWorkflowShellScript: ShellRunner,
) {
  const writeExecutable = (file: string, lines: string[]) =>
    writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o755 });
  const bin = path.join(directory, "bin");
  const argsPath = path.join(directory, "args");
  mkdirSync(bin);
  writeExecutable(path.join(bin, "pnpm"), [
    "#!/bin/sh",
    '[ "$*" = "build qaRuntime" ] || exit 1',
    "mkdir dist || exit 1",
    "touch dist/.buildstamp",
  ]);
  writeExecutable(path.join(bin, "node"), [
    "#!/bin/sh",
    `if [ "$1" = "-p" ]; then echo ${scenario.cpus}; exit 0; fi`,
    'test -f dist/.buildstamp || { echo "runtime not prepared" >&2; exit 1; }',
    'label="${OPENCLAW_TEST_STARTUP_CORPUS_SHARD:-config}"',
    'case "$label" in */*) label="${label%/*}-${label#*/}" ;; esac',
    'printf "%s\\n" "$@" > "$STARTUP_CORPUS_ARGS.$label"',
    // Hold every child until the workflow joins its first batch, so the
    // admission count cannot depend on process startup or completion speed.
    '[ -f "$STARTUP_CORPUS_ARGS.release" ] || read -r release <&3',
    '[ "${OPENCLAW_TEST_STARTUP_CORPUS_SHARD:-config}" != "$STARTUP_CORPUS_FAIL" ]',
  ]);
  const result = runWorkflowShellScript(
    `
    mkfifo "$STARTUP_CORPUS_ARGS.pipe"
    exec 3<> "$STARTUP_CORPUS_ARGS.pipe"
    wait() {
      jobs -pr > "$STARTUP_CORPUS_ARGS.jobs"
      wc -l < "$STARTUP_CORPUS_ARGS.jobs" >> "$STARTUP_CORPUS_ARGS.concurrency"
      touch "$STARTUP_CORPUS_ARGS.release"
      while read -r pid; do printf 'release\\n' >&3; done < "$STARTUP_CORPUS_ARGS.jobs"
      builtin wait "$@"
    }
    ${script}
  `,
    {
      cwd: directory,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        STARTUP_CORPUS_ARGS: argsPath,
        STARTUP_CORPUS_FAIL: scenario.fail ?? "",
      },
    },
  );
  expect(result.status, result.stdout + result.stderr).toBe(scenario.fail ? 1 : 0);
  const admitted = readFileSync(`${argsPath}.concurrency`, "utf8").trim().split(/\s+/u).map(Number);
  expect(Math.max(...admitted)).toBe(scenario.slots);
  if (scenario.fail) {
    expect(result.stdout).toContain("::error::state corpus 1/4 failed");
  }
  const readArgs = (label: string) =>
    readFileSync(`${argsPath}.${label.replace("/", "-")}`, "utf8")
      .trim()
      .split("\n");
  const commonArgs = [
    "scripts/run-vitest.mjs",
    "run",
    "--config",
    "test/vitest/vitest.runtime-config.config.ts",
    ...(scenario.frozenTarget
      ? []
      : [
          "--reporter",
          "verbose",
          "--reporter",
          "github-actions",
          "--reporter",
          "./scripts/lib/vitest-resource-reporter.mts",
        ]),
  ];
  expect(readArgs("config")).toEqual([...commonArgs, "src/config/config-startup-corpus.test.ts"]);
  for (const shard of ["1/4", "2/4", "3/4", "4/4"]) {
    expect(readArgs(shard), shard).toEqual([
      ...commonArgs,
      "src/config/state-startup-corpus.test.ts",
    ]);
  }
}
