import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCrabboxGateCommand } from "../../scripts/pr-lib/crabbox-gate-contract.mjs";
import {
  buildCrabboxGateTransport,
  executeCrabbox,
} from "../../scripts/pr-lib/crabbox-gate-transport.mts";

const headSha = "b".repeat(40);
const temporaryDirectories: string[] = [];
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
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

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), "openclaw-gate-transport-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

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

describe("Crabbox gate payload identity", () => {
  it("streams an expanded plan without changing its canonical command or using oversized argv", () => {
    const targets = Array.from(
      { length: 12_000 },
      (_, index) => `src/features/feature-${String(index).padStart(5, "0")}.test.ts`,
    );
    const command = buildCrabboxGateCommand(
      {
        baseSha: "c".repeat(40),
        changedPaths: [{ path: "src/features/index.ts", status: "M" }],
        headSha,
        targets,
        version: 1,
      },
      digest(bootstrap),
    );
    const transport = buildCrabboxGateTransport({ bootstrap, command, headSha });
    expect(Buffer.byteLength(command)).toBeGreaterThan(128 * 1024);
    expect(transport.args).toEqual([
      headSha,
      digest(bootstrap),
      digest(command),
      digest(transport.input),
    ]);
    expect(Math.max(...transport.args.map((arg) => Buffer.byteLength(arg)))).toBe(64);
    expect(transport.input).toContain(`${command}\nOPENCLAW_GATE_${digest(command)}\n`);
    expect(transport.input).toContain(`${bootstrap}\n}`);
    expect(transport.uploadPath).toBe(
      `.crabbox/scripts/${digest(transport.input).slice(0, 12)}-script.sh`,
    );
  });
});

// The production launcher targets the Linux AWS guest's Bash and sha256sum.
describe.skipIf(process.platform !== "linux")("Crabbox Linux launcher", () => {
  it("preserves positional arguments, literal payload bytes and EXIT cleanup", () => {
    const command = "set -euo pipefail; printf '%s\\n' '$HOME `false` $(false)'";
    const result = launch(command);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      `head:${headSha} command:openclaw_gate\n$HOME \`false\` $(false)\ncleanup:0\n`,
    );
    expect(result.stderr).toBe("");
  });

  it("keeps child errexit even through the bootstrap's conditional failure capture", () => {
    const result = launch("set -euo pipefail; /bin/bash -c 'exit 37'; printf unreachable");
    expect(result.status).toBe(37);
    expect(result.stdout).toBe(`head:${headSha} command:openclaw_gate\ncleanup:37\n`);
  });

  it("keeps early bootstrap errexit and never invokes the gate", () => {
    const result = launch(
      "printf unreachable",
      bootstrap.replace("command_status=0", "false\ncommand_status=0"),
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe(`head:${headSha} command:openclaw_gate\ncleanup:1\n`);
  });

  it("runs a payload larger than the Linux single-argument limit as exact script bytes", () => {
    const output = path.join(temporaryDirectory(), "command.sh");
    const command = `set -euo pipefail\n#${"x".repeat(600_000)}\ncat /dev/fd/3 > '${output}'\n! declare -F openclaw_gate`;
    const result = launch(command);
    expect(result.status).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(`${command}\n`);
    expect(result.stdout).toContain("cleanup:0\n");
  });

  it.each([0, 1, 2, 3])("rejects altered identity argument %i before bootstrap", (index) => {
    const result = launch("printf unreachable", bootstrap, (transport) => {
      transport.args = transport.args.map((arg, position) =>
        position === index ? "f".repeat(arg.length) : arg,
      );
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });

  it("rejects altered uploaded bytes before bootstrap", () => {
    const result = launch("printf unreachable", bootstrap, (transport) => {
      transport.input += "# changed\n";
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });
});

describe("Crabbox stdin lifecycle", () => {
  it("delivers the complete payload and retains the joined child result", async () => {
    const input = "x".repeat(600_000);
    const result = await executeCrabbox({
      args: [
        "-e",
        "let n=0; process.stdin.on('data', b=>n+=b.length); process.stdin.on('end',()=>console.log(n));",
      ],
      bin: process.execPath,
      env: process.env,
      input,
    });
    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "600000\n" });
  });

  it.each([0, 37])(
    "joins an early stdin close and preserves child failure %i",
    async (exitCode) => {
      const finished = path.join(temporaryDirectory(), "finished");
      const result = executeCrabbox({
        args: [
          "-e",
          "const fs=require('node:fs'); fs.closeSync(0); fs.writeFile(process.argv[1],'finished',error=>{if(error)throw error; process.exit(Number(process.argv[2]));});",
          finished,
          String(exitCode),
        ],
        bin: process.execPath,
        env: process.env,
        input: "x".repeat(8 * 1024 * 1024),
      });
      if (exitCode === 0) {
        await expect(result).rejects.toThrow();
      } else {
        await expect(result).resolves.toMatchObject({ exitCode });
      }
      expect(readFileSync(finished, "utf8")).toBe("finished");
    },
  );
});
