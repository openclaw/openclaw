import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

function runNode(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "ignore", "pipe"],
      env,
      cwd,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stderr }));
  });
}

async function writeFakePnpm(binDir: string, logPath: string): Promise<void> {
  const pnpmPath = path.join(binDir, "pnpm");
  // This repo is ESM (`type: "module"`), and we write the fake binary under the
  // repo root so Node treats it as ESM too.
  const script = `#!/usr/bin/env node
import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");
process.exit(0);
`;
  await fs.writeFile(pnpmPath, script, { encoding: "utf8", mode: 0o755 });
}

async function readJsonl(pathname: string): Promise<Array<{ argv: string[] }>> {
  const raw = await fs.readFile(pathname, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { argv: string[] });
}

describe("scripts/ui.js", () => {
  it("strips inline-comment args after '#'", async () => {
    const repoRoot = process.cwd();
    // Some environments mount os.tmpdir() as noexec; create our fake binary under the repo instead.
    const tmp = await fs.mkdtemp(path.join(repoRoot, ".tmp-openclaw-ui-script-"));
    const binDir = path.join(tmp, "bin");
    const logPath = path.join(tmp, "pnpm.jsonl");
    await fs.mkdir(binDir, { recursive: true });
    await writeFakePnpm(binDir, logPath);

    try {
      const scriptPath = path.join(repoRoot, "scripts", "ui.js");

      const env = {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      };

      const res = await runNode(
        [scriptPath, "build", "#", "auto-installs", "ui", "deps"],
        env,
        repoRoot,
      );
      expect(res.stderr).toBe("");
      expect(res.code).toBe(0);

      const calls = await readJsonl(logPath);
      const runCall = calls.find((call) => call.argv[0] === "run" && call.argv[1] === "build");
      expect(runCall).toBeTruthy();
      expect(runCall?.argv).toEqual(["run", "build"]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("preserves args when no '#'", async () => {
    const repoRoot = process.cwd();
    const tmp = await fs.mkdtemp(path.join(repoRoot, ".tmp-openclaw-ui-script-"));
    const binDir = path.join(tmp, "bin");
    const logPath = path.join(tmp, "pnpm.jsonl");
    await fs.mkdir(binDir, { recursive: true });
    await writeFakePnpm(binDir, logPath);

    try {
      const scriptPath = path.join(repoRoot, "scripts", "ui.js");

      const env = {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      };

      const res = await runNode([scriptPath, "build", "--foo"], env, repoRoot);
      expect(res.stderr).toBe("");
      expect(res.code).toBe(0);

      const calls = await readJsonl(logPath);
      const runCall = calls.find((call) => call.argv[0] === "run" && call.argv[1] === "build");
      expect(runCall?.argv).toEqual(["run", "build", "--foo"]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
