import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-run-node-"));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("run-node script", () => {
  it.runIf(process.platform !== "win32")(
    "preserves control-ui assets by building with tsdown --no-clean",
    async () => {
      await withTempDir(async (tmp) => {
        const runNodeScript = path.join(process.cwd(), "scripts", "run-node.mjs");
        const fakeBinDir = path.join(tmp, ".fake-bin");
        const fakePnpmPath = path.join(fakeBinDir, "pnpm");
        const argsPath = path.join(tmp, ".pnpm-args.txt");
        const indexPath = path.join(tmp, "dist", "control-ui", "index.html");

        await fs.mkdir(fakeBinDir, { recursive: true });
        await fs.mkdir(path.dirname(indexPath), { recursive: true });
        await fs.writeFile(indexPath, "<html>sentinel</html>\n", "utf-8");

        await fs.writeFile(
          path.join(tmp, "openclaw.mjs"),
          "#!/usr/bin/env node\nif (process.argv.includes('--version')) console.log('9.9.9-test');\n",
          "utf-8",
        );
        await fs.chmod(path.join(tmp, "openclaw.mjs"), 0o755);

        const fakePnpm = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const cwd = process.cwd();
fs.writeFileSync(path.join(cwd, ".pnpm-args.txt"), args.join(" "), "utf-8");
if (!args.includes("--no-clean")) {
  fs.rmSync(path.join(cwd, "dist", "control-ui"), { recursive: true, force: true });
}
fs.mkdirSync(path.join(cwd, "dist"), { recursive: true });
fs.writeFileSync(path.join(cwd, "dist", "entry.js"), "export {}\\n", "utf-8");
`;
        await fs.writeFile(fakePnpmPath, fakePnpm, "utf-8");
        await fs.chmod(fakePnpmPath, 0o755);

        const env = {
          ...process.env,
          PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
          OPENCLAW_FORCE_BUILD: "1",
          OPENCLAW_RUNNER_LOG: "0",
        };
        const result = spawnSync(process.execPath, [runNodeScript, "--version"], {
          cwd: tmp,
          env,
          encoding: "utf-8",
        });

        expect(result.status).toBe(0);
        expect(result.stdout).toContain("9.9.9-test");
        await expect(fs.readFile(argsPath, "utf-8")).resolves.toContain("exec tsdown --no-clean");
        await expect(fs.readFile(indexPath, "utf-8")).resolves.toContain("sentinel");
      });
    },
  );
});
