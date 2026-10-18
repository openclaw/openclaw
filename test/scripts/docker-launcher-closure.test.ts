import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["dependency-inputs", "runtime"])(
  "runs the launcher copied into the Docker %s stage",
  async (stage) => {
    const dockerfile = await fs.readFile("Dockerfile", "utf8");
    const stages = dockerfile.split(/^FROM /mu);
    const source =
      stage === "runtime"
        ? stages.at(-1)!
        : stages.find((entry) => entry.split("\n", 1)[0]?.endsWith(` AS ${stage}`))!;
    const files = new Set(
      [...source.matchAll(/^COPY .+$/gmu)].flatMap(([line]) =>
        [...line.matchAll(/(?:^|\s)(?:\/app\/)?([\w-]+\.mjs)(?=\s|$)/gu)].map((match) => match[1]!),
      ),
    );
    const root = tempDirs.make("docker-launcher-closure-");
    await Promise.all([...files].map((file) => fs.copyFile(file, path.join(root, file))));
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
