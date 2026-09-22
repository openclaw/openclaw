import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requireNodeTool } from "../helpers/node-toolchain.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  policyTimeoutCapture,
  policyTimeoutQualification,
} from "./pr-merge-policy-timeout.test-support.js";

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
const historicalRefusals = {
  "0.6.10": {
    kind: "octopool-0.6.10-auto-refusal",
    version: "0.6.10",
    sourceRevision: "00c442d8084ad26eb5a5003f7372170e75a20c8a",
    parserSha256: "f6ff8cd7e59503f71f94fefd561b671193df11b3aac9ba0986a0dc3ba91ca32b",
  },
  "0.7.1": {
    kind: "octopool-0.7.1-missing-subject-refusal",
    version: "0.7.1",
    sourceRevision: "7ab9b348c99a7be4fdc82c75cb06ebce44e0007e",
    parserSha256: "b32cb960537f5ffa1336a7689674afba9b4a2485b05e449acd2684a251ff8970",
  },
} as const;
const hash = (text: string) =>
  execFileSync("git", ["hash-object", "--stdin"], { input: text, encoding: "utf8" }).trim();
const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("operator-qualified pre-dispatch evidence", () => {
  it.each([
    "approved",
    "uninspected",
    "diagnostics-not-requested",
    "wrong-producer",
    "wrong-command",
    "wrong-version",
    "wrong-revision",
    "wrong-executable",
    "missing-source",
    "extra-source",
    ...Object.keys(policyTimeoutQualification.sourceSha256).map((path) => `source:${path}`),
    "policy-denial",
    "other-class",
    "extra-text",
    "extra-newline",
    "missing-newline",
    "diagnostic",
    "child-started",
    "response-headers",
  ])("bounds the inspected initial policy timeout: %s", (fault) => {
    const root = temps.make("pr-policy-timeout-evidence-");
    const directory = join(root, "evidence");
    mkdirSync(directory);
    mkdirSync(join(root, ".local"));
    const sourceSha256: Record<string, string> = { ...policyTimeoutQualification.sourceSha256 };
    if (fault.startsWith("source:")) {
      sourceSha256[fault.slice("source:".length)] = "0".repeat(64);
    }
    if (fault === "missing-source") {
      delete sourceSha256["cmd/octopool/gh.go"];
    }
    if (fault === "extra-source") {
      sourceSha256["cmd/octopool/unknown.go"] = "0".repeat(64);
    }
    let contents = policyTimeoutCapture;
    if (fault === "policy-denial") {
      contents = refusal;
    }
    if (fault === "other-class") {
      contents = contents.replace("class=timeout", "class=server_validation");
    }
    if (fault === "extra-text") {
      contents += "mutation accepted\n";
    }
    if (fault === "extra-newline") {
      contents += "\n";
    }
    if (fault === "missing-newline") {
      contents = contents.trimEnd();
    }
    if (fault === "diagnostic" || fault === "child-started") {
      contents +=
        fault === "diagnostic"
          ? diagnostic
          : diagnostic.replace("child_started=false", "child_started=true");
    }
    if (fault === "response-headers") {
      contents = contents.replace(")\n", " http_status=504)\n");
    }
    const proof = {
      ...policyTimeoutQualification,
      outcome,
      capture: hash(contents),
      inspected: fault !== "uninspected",
      diagnosticsEnabled: fault !== "diagnostics-not-requested",
      producer: fault === "wrong-producer" ? "gh" : policyTimeoutQualification.producer,
      command: fault === "wrong-command" ? "pr view" : policyTimeoutQualification.command,
      version: fault === "wrong-version" ? "0.7.2" : policyTimeoutQualification.version,
      sourceRevision:
        fault === "wrong-revision" ? "a".repeat(40) : policyTimeoutQualification.sourceRevision,
      executableSha256:
        fault === "wrong-executable" ? "a".repeat(64) : policyTimeoutQualification.executableSha256,
      sourceSha256,
    };
    writeFileSync(join(root, ".local", capture), contents);
    writeFileSync(join(directory, capture), contents);
    writeFileSync(join(directory, "qualification.json"), JSON.stringify(proof));
    const result = spawnSync(node, [helper, directory, outcome, JSON.stringify(record)], {
      cwd: root,
      encoding: "utf8",
    });
    if (fault === "approved") {
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

  it.each([
    "historical",
    "historical-0.7.1",
    "0.7.1-wrong-version",
    "0.7.1-wrong-source",
    "0.7.1-wrong-parser",
    "0.7.1-subject",
    "0.7.1-subject-equals",
    "0.7.1-altered-stderr",
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
    const historical =
      historicalRefusals[
        fault.startsWith("0.7.1-") || fault === "historical-0.7.1" ? "0.7.1" : "0.6.10"
      ];
    let contents = diagnostics ? diagnostic + refusal : refusal;
    if (fault === "started") {
      contents = contents.replace("child_started=false", "child_started=true");
    }
    if (fault === "duplicate") {
      contents += diagnostic;
    }
    if (fault === "0.7.1-altered-stderr") {
      contents += diagnostic.replace("child_started=false", "child_started=true");
    }
    const args = [
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
    ];
    if (fault === "0.7.1-subject") {
      args.push("--subject", "Fixture subject");
    }
    if (fault === "0.7.1-subject-equals") {
      args.push("--subject=Fixture subject");
    }
    const proof = {
      outcome: fault === "wrong-outcome" ? "c".repeat(40) : outcome,
      capture: hash(contents),
      inspected: fault !== "generic-only",
      ...(diagnostics
        ? { kind: "octopool-merge-diagnostics", producer: "octopool", diagnosticsEnabled: true }
        : {
            ...historical,
            version: fault === "0.7.1-wrong-version" ? "0.7.0" : historical.version,
            sourceRevision:
              fault === "0.7.1-wrong-source" ? "a".repeat(40) : historical.sourceRevision,
            parserSha256:
              fault === "wrong-source" || fault === "0.7.1-wrong-parser"
                ? "a".repeat(64)
                : historical.parserSha256,
            args,
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
    if (fault === "historical" || fault === "historical-0.7.1" || fault === "diagnostic") {
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
