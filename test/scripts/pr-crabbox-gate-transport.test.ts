import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCrabboxGateTransport,
  executeCrabbox,
} from "../../scripts/pr-lib/crabbox-gate-transport.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const headSha = "b".repeat(40);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const bootstrap = `#!/usr/bin/env bash
set -euo pipefail
expected_head_sha="$1"
shift
trap 'printf "cleanup:%s\\n" "$?"' EXIT
printf 'head:%s command:%s\\n' "$expected_head_sha" "$1"
command_status=0
"$@" || command_status=$?
exit "$command_status"
`;
const earlyBootstrap = bootstrap.replace("command_status=0", "false\ncommand_status=0");

const temporaryDirectory = () => tempDirs.make("openclaw-gate-transport-");
const execution = { bin: process.execPath, env: process.env };
const literal = "$HOME `false` $(false)";

const execute = (input: string, program: string, ...args: string[]) =>
  executeCrabbox({ ...execution, args: ["-e", program, ...args], input });

function launch(
  command: string,
  bootstrapSource = bootstrap,
  alter?: (value: { args: string[]; input: string }) => void,
) {
  const transport = buildCrabboxGateTransport({ bootstrap: bootstrapSource, command, headSha });
  alter?.(transport);
  const script = path.join(temporaryDirectory(), "script.sh");
  writeFileSync(script, transport.input);
  return spawnSync("/bin/bash", [script, ...transport.args], { encoding: "utf8" });
}

describe.skipIf(process.platform !== "linux")("Crabbox Linux launcher", () => {
  it.each([
    ["literal bytes", `set -euo pipefail; printf '%s\\n' '${literal}'`, 0, `${literal}\n`],
    ["child errexit", "set -euo pipefail; /bin/bash -c 'exit 37'; printf unreachable", 37],
    ["early bootstrap errexit", "printf unreachable", 1, "", earlyBootstrap],
  ] as const)("EXIT cleanup: %s", (_label, command, exitCode, output = "", source = bootstrap) => {
    const result = launch(command, source);
    expect(result).toMatchObject({
      status: exitCode,
      stdout: `head:${headSha} command:openclaw_gate\n${output}cleanup:${exitCode}\n`,
      ...(exitCode === 0 ? { stderr: "" } : {}),
    });
  });

  it("runs a payload larger than the Linux single-argument limit as exact script bytes", () => {
    const output = path.join(temporaryDirectory(), "command.sh");
    const command = `set -euo pipefail\n#${"x".repeat(600_000)}\ncat /dev/fd/3 > '${output}'\n! declare -F openclaw_gate`;
    const result = launch(command);
    expect(result.status).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(`${command}\n`);
    expect(result.stdout).toContain("cleanup:0\n");
  });

  it.each([0, 1, 2, 3, "bytes"] as const)("rejects altered %s before bootstrap", (index) => {
    const result = launch("printf unreachable", bootstrap, (transport) => {
      if (index === "bytes") {
        transport.input += "# changed\n";
      } else {
        transport.args = transport.args.map((arg, position) =>
          position === index ? "f".repeat(arg.length) : arg,
        );
      }
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });
});

it("delivers the complete payload and retains the joined child result", async () => {
  const result = await execute(
    "x".repeat(600_000),
    "let n=0; process.stdin.on('data', b=>n+=b.length); process.stdin.on('end',()=>console.log(n));",
  );
  expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "600000\n" });
});

it.each([0, 37])("joins an early stdin close and preserves child failure %i", async (exitCode) => {
  const finished = path.join(temporaryDirectory(), "finished");
  const result = execute(
    "x".repeat(8 * 1024 * 1024),
    "const fs=require('node:fs'); fs.closeSync(0); fs.writeFile(process.argv[1],'finished',error=>{if(error)throw error; process.exit(Number(process.argv[2]));});",
    finished,
    String(exitCode),
  );
  if (exitCode === 0) {
    await expect(result).rejects.toThrow();
  } else {
    await expect(result).resolves.toMatchObject({ exitCode });
  }
  expect(readFileSync(finished, "utf8")).toBe("finished");
});
