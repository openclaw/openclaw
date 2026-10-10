import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const workflow = parse(readFileSync(".github/workflows/codeql-critical-quality.yml", "utf8")) as {
  jobs: Record<string, { steps: { id?: string; name: string; run?: string }[] }>;
};
const steps = [
  ...expectDefined(workflow.jobs["quality-shards"], "CodeQL shard selection job").steps,
  ...expectDefined(workflow.jobs["network-runtime-boundary"], "network CodeQL job").steps,
];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const qaOwner = "extensions/qa-lab/src/gateway-child-setup.ts";
const codexTransport = "extensions/codex/src/app-server/transport-websocket.ts";

function runStep(name: string, root: string, env: Record<string, string>) {
  const script = steps.find((step) => step.id === name || step.name === name)?.run;
  if (!script) {
    throw new Error(`Missing workflow script: ${name}`);
  }
  return spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, ...env },
    timeout: 10_000,
  });
}

function scan(
  files: { filename: string; patch?: string | null }[],
  failCall = 0,
  step = "network-diff-scan",
  response?: string,
) {
  const root = tempDirs.make("codeql-network-scan-");
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(root, "files.json"), response ?? JSON.stringify(files));
  writeFileSync(path.join(root, "calls"), "0");
  const output = path.join(root, "output");
  writeFileSync(output, "");
  // Execute the workflow's own jq filters, replacing only the GitHub API boundary.
  writeFileSync(
    path.join(bin, "gh"),
    `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == api && "$2" == --paginate && "$3" == repos/openclaw/openclaw/pulls/123/files ]]
call=$(( $(cat calls) + 1 ))
echo "$call" > calls
if [[ "$call" == "$FAIL_CALL" ]]; then
  echo "synthetic GitHub fetch failure" >&2
  exit 7
fi
if [[ "$#" == 3 ]]; then
  cat files.json
else
  [[ "$#" == 5 && "$4" == --jq ]]
  exec jq -r "$5" files.json
fi
`,
    { mode: 0o755 },
  );
  const result = runStep(step, root, {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    PR_NUMBER: "123",
    REPOSITORY: "openclaw/openclaw",
    GITHUB_OUTPUT: output,
    FAIL_CALL: String(failCall),
    EVENT_NAME: "pull_request",
  });
  return {
    result,
    output: readFileSync(output, "utf8"),
  };
}

describe("network CodeQL PR routing", () => {
  it("selects the network shard for its semantic fixtures", () => {
    const { result, output } = scan(
      [
        {
          filename:
            ".github/codeql/openclaw-boundary/tests/network-runtime/packages/net-policy/src/client.ts",
        },
      ],
      0,
      "detect",
    );
    expect(result.status, result.stderr).toBe(0);
    expect(output.split("\n")).toContain("network_runtime=true");
  });

  it.each([
    ["net import", qaOwner, '+import net from "node:net";'],
    ["tls require", "extensions/irc/src/client.ts", '+const tls = require("tls");'],
    ["raw connection", "src/infra/net/client.ts", "+net.createConnection(options);"],
    ["socket constructor", "src/infra/jsonl-socket.ts", "+new Socket();"],
  ])("routes %s", (_name, filename, patch) => {
    const { result, output } = scan([{ filename, patch }]);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(output.trim()).toBe("full_codeql=true");
  });

  it("requires semantic review when a monitored source patch is unavailable", () => {
    const { result, output } = scan([{ filename: qaOwner, patch: null }]);
    expect(result.status, result.stderr).toBe(0);
    expect(output.trim()).toBe("full_codeql=true");
  });

  it("escalates added proxy references", () => {
    const { result, output } = scan([
      {
        filename: "src/infra/net/proxy/proxy-lifecycle.ts",
        patch: "+process.env.HTTP_PROXY = value;",
      },
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(output.trim()).toBe("full_codeql=true");
  });

  it.each([
    ".github/codeql/codeql-network-runtime-boundary-critical-quality.yml",
    ".github/codeql/openclaw-boundary/queries/raw-socket-callsite-classification.ql",
    ".github/codeql/openclaw-boundary/tests/network-runtime/raw-socket-callsite-classification.qlref",
    codexTransport,
  ])("always escalates contract owner %s", (filename) => {
    const { result, output } = scan([{ filename }]);
    expect(result.status, result.stderr).toBe(0);
    expect(output.trim()).toBe("full_codeql=true");
  });

  it.each(["network-diff-scan", "detect"])(
    "fails closed when GitHub metadata fails in %s",
    (step) => {
      const { result, output } = scan(
        [{ filename: qaOwner, patch: "+const ready = true;" }],
        1,
        step,
      );
      expect(result.status).toBe(7);
      expect(result.stderr).toContain("synthetic GitHub fetch failure");
      expect(output).toBe("");
    },
  );

  it.each(["network-diff-scan", "detect"])("fails closed on malformed metadata in %s", (step) => {
    const { result, output } = scan([], 0, step, "{");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("parse error");
    expect(output).toBe("");
  });
});

describe("network CodeQL findings gate", () => {
  it.each([
    [
      "warning finding",
      JSON.stringify({
        runs: [{ results: [{ level: "warning", message: { text: "proxy mutation" } }] }],
      }),
    ],
    ["missing SARIF", undefined],
    ["invalid SARIF", "{"],
  ])("rejects %s", (_name, sarif) => {
    const root = tempDirs.make("codeql-network-findings-");
    if (sarif !== undefined) {
      writeFileSync(path.join(root, "result.sarif"), sarif);
    }
    const result = runStep("Fail on network runtime boundary findings", root, {
      SARIF_OUTPUT: root,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).not.toBe(0);
  });
});
