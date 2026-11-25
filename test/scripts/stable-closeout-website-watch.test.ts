import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(readFileSync(".github/workflows/openclaw-stable-main-closeout.yml", "utf8"));
const script: string = workflow.jobs.verify.steps.find(
  (entry: { name: string }) => entry.name === "Verify the production website downloads",
).run;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Fake gh: the dispatched run's jobs return 404 for the first two reads, and
// `run watch` fails the same way GitHub's CLI did while they are unreadable.
function runStep() {
  const dir = mkdtempSync(join(tmpdir(), "closeout-website-watch-"));
  dirs.push(dir);
  const fake = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  fake(
    "gh",
    [
      'reads="$(cat "$FAKE_DIR/reads" 2>/dev/null || echo 0)"',
      'if [[ "$1 $2" == "api --method" ]]; then echo 45481076962; exit 0; fi',
      'if [[ "$1" == "api" || "$1 $2" == "run watch" ]]; then',
      '  echo $((reads + 1)) > "$FAKE_DIR/reads"',
      '  if (( reads < 2 )); then echo "HTTP 404: Not Found" >&2; exit 1; fi',
      '  [[ "$1" == "run" ]] && echo watched',
      "  exit 0",
      "fi",
      "exit 2",
    ].join("\n"),
  );
  fake("sleep", "exit 0");
  return execFileSync("bash", ["-e", "-c", script], {
    encoding: "utf8",
    env: {
      FAKE_DIR: dir,
      GH_TOKEN: "test",
      GITHUB_STEP_SUMMARY: join(dir, "summary"),
      PATH: `${dir}:${process.env.PATH}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

it("waits for a just-dispatched website run to become readable before watching it", () => {
  expect(runStep()).toContain("watched");
});
