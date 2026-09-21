import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requireNodeTool } from "../helpers/node-toolchain.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const helper = join(process.cwd(), "scripts/pr-lib/merge-pre-dispatch-refusal.mjs");
const node = requireNodeTool("node");
const outcome = "a".repeat(40);
const record = {
  phase: "intent",
  accepted: false,
  route: "auto",
  method: "squash",
  attempt: "00000000-0000-0000-0000-000000000001",
  pr: 123,
  head: "b".repeat(40),
  repo: { url: "https://github.com/fixture/repo" },
};
const capture = `merge-output.${record.attempt}.log`;
const refusal = "error: string rewrite protection blocked unsafe input\n";
const diagnostic =
  "octopool: merge_diagnostics attempt_utc=2026-09-21T12:00:00Z elapsed_ms=1 child_started=false outcome=preparation_failed headers=unavailable\n";
const hash = (text: string) =>
  execFileSync("git", ["hash-object", "--stdin"], { input: text, encoding: "utf8" }).trim();
const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("operator-qualified pre-dispatch evidence", () => {
  it.each([
    "historical",
    "diagnostic",
    "generic-only",
    "wrong-source",
    "changed-capture",
    "symlink",
    "accepted",
    "queue",
    "started",
    "duplicate",
    "extra-capture",
    "extra-evidence",
    "wrong-outcome",
  ])("qualifies only intact, inspected no-dispatch evidence: %s", (fault) => {
    const root = temps.make("pr-refusal-evidence-");
    const directory = join(root, "evidence");
    mkdirSync(directory);
    mkdirSync(join(root, ".local"));
    const diagnostics = ["diagnostic", "started", "duplicate"].includes(fault);
    let contents = diagnostics ? diagnostic + refusal : refusal;
    if (fault === "started") {
      contents = contents.replace("child_started=false", "child_started=true");
    }
    if (fault === "duplicate") {
      contents += diagnostic;
    }
    const proof = {
      outcome: fault === "wrong-outcome" ? "c".repeat(40) : outcome,
      capture: hash(contents),
      inspected: fault !== "generic-only",
      ...(diagnostics
        ? { kind: "octopool-merge-diagnostics", producer: "octopool", diagnosticsEnabled: true }
        : {
            kind: "octopool-0.6.10-auto-refusal",
            version: "0.6.10",
            sourceRevision: "00c442d8084ad26eb5a5003f7372170e75a20c8a",
            parserSha256:
              fault === "wrong-source"
                ? "a".repeat(64)
                : "f6ff8cd7e59503f71f94fefd561b671193df11b3aac9ba0986a0dc3ba91ca32b",
            args: [
              "pr",
              "merge",
              "123",
              "--repo",
              record.repo.url,
              "--squash",
              "--auto",
              "--match-head-commit",
              record.head,
              "--body-file",
              ".local/merge-body.fixture",
            ],
          }),
    };
    writeFileSync(join(root, ".local", capture), contents);
    writeFileSync(join(directory, capture), fault === "changed-capture" ? "changed\n" : contents);
    writeFileSync(join(directory, "qualification.json"), JSON.stringify(proof));
    if (fault === "symlink") {
      rmSync(join(directory, capture));
      symlinkSync(join(root, ".local", capture), join(directory, capture));
    }
    if (fault === "extra-evidence") {
      writeFileSync(join(directory, "other.log"), refusal);
    }
    if (fault === "extra-capture") {
      writeFileSync(join(root, ".local/merge-output.other.log"), refusal);
    }
    const attempt = {
      ...record,
      accepted: fault === "accepted",
      route: fault === "queue" ? "queue" : record.route,
    };
    const result = spawnSync(node, [helper, directory, outcome, JSON.stringify(attempt)], {
      cwd: root,
      encoding: "utf8",
    });
    if (fault === "historical" || fault === "diagnostic") {
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        kind: proof.kind,
        capture,
        files: { [capture]: proof.capture },
      });
    } else {
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toBe("");
    }
  });
});
