import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const vitestDir = path.dirname(createRequire(import.meta.url).resolve("vitest/package.json"));

export function createRunnerFixtureEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined &&
        !key.startsWith("VITEST") &&
        !key.startsWith("OPENCLAW_VITEST") &&
        key !== "GITHUB_ACTIONS",
    ),
  );
}

export async function withRunnerFixture(
  name: string,
  run: (fixture: { root: string; args: string[]; env: NodeJS.ProcessEnv }) => Promise<void>,
) {
  const parent = path.join(repoRoot, ".artifacts", name);
  await fs.mkdir(parent, { recursive: true });
  // openclaw-temp-dir: allow retains failed or unjoined child fixtures for diagnosis.
  const root = await fs.mkdtemp(path.join(parent, "run-"));
  try {
    await fs.symlink(path.dirname(vitestDir), path.join(root, "node_modules"), "junction");
    await run({
      root,
      args: [
        path.join(vitestDir, "vitest.mjs"),
        "run",
        "--root",
        root,
        "--config",
        path.join(root, "vitest.config.ts"),
        "--configLoader",
        "runner",
        "--reporter=verbose",
      ],
      env: createRunnerFixtureEnv(),
    });
    await fs.rm(root, { recursive: true, force: true });
  } catch (error) {
    if (error instanceof Error) {
      error.message += `; retained fixture ${root}`;
    }
    throw error;
  }
}
