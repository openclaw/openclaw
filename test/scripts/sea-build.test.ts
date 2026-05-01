import { execFile, type ExecFileException } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

function hostTarget() {
  return `${process.platform}-${process.arch}`;
}

function nonHostTarget() {
  return hostTarget() === "linux-x64" ? "darwin-x64" : "linux-x64";
}

async function expectScriptFailure(args: string[]) {
  try {
    await execFileAsync(process.execPath, args, {
      cwd: process.cwd(),
      env: { ...process.env, OPENCLAW_SEA_ALLOW_UNPINNED_NODE: undefined },
    });
  } catch (error) {
    const failure = error as ExecFileException & { stderr?: string };
    return failure.stderr ?? "";
  }
  throw new Error(`expected ${args.join(" ")} to fail`);
}

describe("SEA build scripts", () => {
  it("refuses to stage host node_modules for a different target platform", async () => {
    const stderr = await expectScriptFailure([
      "scripts/build-sea.mjs",
      "--target",
      nonHostTarget(),
      "--skip-build",
    ]);

    expect(stderr).toContain(`cannot build ${nonHostTarget()} SEA package on ${hostTarget()}`);
    expect(stderr).toContain("sidecar node_modules can contain native packages");
  });

  it("requires a pinned checksum for Node.js archive downloads by default", async () => {
    const stderr = await expectScriptFailure([
      "scripts/fetch-node-for-sea.mjs",
      "--target",
      "linux-x64",
      "--version",
      "25.8.0",
    ]);

    expect(stderr).toContain("no pinned SHA256 for node-v25.8.0-");
    expect(stderr).toContain("OPENCLAW_SEA_ALLOW_UNPINNED_NODE=1");
  });
});
