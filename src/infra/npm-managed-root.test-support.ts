import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { captureEnv } from "../test-utils/env.js";

export const successfulSpawn = {
  code: 0,
  stdout: "",
  stderr: "",
  signal: null,
  killed: false,
  termination: "exit" as const,
};

export async function writeFixtureJson(file: string, value: unknown): Promise<void> {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readManifest(root: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
}

export function useManagedNpmRootFixture() {
  const tracker = createSuiteTempRootTracker({ prefix: "openclaw-npm-managed-root-" });
  const tempDirs: string[] = [];
  let snapshot: ReturnType<typeof captureEnv> | undefined;
  beforeAll(async () => {
    const root = await tracker.setup();
    snapshot = captureEnv(["NPM_CONFIG_GLOBALCONFIG"]);
    const config = path.join(root, "global-npmrc");
    await fs.writeFile(config, "", "utf8");
    process.env.NPM_CONFIG_GLOBALCONFIG = config;
  });
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });
  afterAll(async () => {
    snapshot?.restore();
    snapshot = undefined;
    await tracker.cleanup();
  });
  return async (manifest?: unknown) => {
    const dir = await tracker.make("case");
    tempDirs.push(dir);
    if (manifest !== undefined) {
      await writeFixtureJson(path.join(dir, "package.json"), manifest);
    }
    return dir;
  };
}
