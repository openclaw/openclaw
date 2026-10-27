import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function copyDockerStageModules(stage: string, root: string) {
  const dockerfile = await fs.readFile("Dockerfile", "utf8");
  const stages = dockerfile.split(/^FROM /mu);
  const source =
    stage === "runtime"
      ? stages.at(-1)!
      : stages.find((entry) => entry.split("\n", 1)[0]?.endsWith(` AS ${stage}`))!;
  for (const [line] of source.matchAll(/^COPY .+$/gmu)) {
    const inputs = line
      .slice(5)
      .split(/\s+/u)
      .filter((word) => !word.startsWith("--"));
    const destination = inputs.pop();
    if (!destination) {
      throw new Error("Docker COPY must have a destination");
    }
    for (const file of inputs.filter((input) => input.endsWith(".mjs"))) {
      const relative = file.replace(/^\/app\//u, "");
      const output = path.join(
        root,
        destination === "." || destination.endsWith("/") || inputs.length > 1
          ? path.join(destination, path.basename(file))
          : destination,
      );
      await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.copyFile(relative, output);
    }
  }
}

it.each(["dependency-inputs", "runtime"])(
  "runs the launcher copied into the Docker %s stage",
  async (stage) => {
    const root = tempDirs.make("docker-launcher-closure-");
    await copyDockerStageModules(stage, root);
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "2026.10.3" }));
    const { stdout } = await promisify(execFile)(
      resolveTestNodeExecPath(),
      [path.join(root, "openclaw.mjs"), "--version"],
      {
        cwd: root,
        env: { HOME: root, CFFIXED_USER_HOME: root, TMPDIR: root },
      },
    );
    expect(stdout.trim()).toBe("OpenClaw 2026.10.3");
  },
);

it("imports install hooks from the Docker dependency inputs without dependencies or lifecycle effects", async () => {
  const root = tempDirs.make("docker-install-hook-closure-");
  await copyDockerStageModules("dependency-inputs", root);
  const pending = path.join(root, ".openclaw-lifecycle-pending");
  await fs.writeFile(pending, "pending\n");
  const entry = path.join(root, "import-hooks.mjs");
  await fs.writeFile(
    entry,
    `await import("./scripts/preinstall-package-manager-warning.mjs");
await import("./scripts/postinstall-bundled-plugins.mjs");
process.stdout.write("hooks imported\\n");
`,
  );
  const { stdout } = await promisify(execFile)(resolveTestNodeExecPath(), [entry], {
    cwd: root,
    env: { HOME: root, CFFIXED_USER_HOME: root, TMPDIR: root },
  });
  expect(stdout).toBe("hooks imported\n");
  expect(await fs.readFile(pending, "utf8")).toBe("pending\n");
});
