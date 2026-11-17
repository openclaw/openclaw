import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isRetiredPnpmGenerationOfInstall } from "./update-global-pnpm-retired.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("recognizes only absent pnpm generations from the active installation", async () => {
  const home = tempDirs.make("openclaw-retired-pnpm-");
  const globalRoot = path.join(home, "global/v11");
  const project = path.join(globalRoot, "active");
  const activeRoot = path.join(project, "node_modules/openclaw");
  await fs.mkdir(activeRoot, { recursive: true });
  await fs.writeFile(
    path.join(activeRoot, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.11.5" }),
  );
  await fs.writeFile(
    path.join(project, "package.json"),
    JSON.stringify({ dependencies: { openclaw: "2026.11.5" } }),
  );
  await fs.writeFile(path.join(project, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  await fs.symlink(project, path.join(globalRoot, "hash-active"), "junction");
  const retired = path.join(project, "node_modules/.pnpm/openclaw@2026.9.37/node_modules/openclaw");
  const check = (root: string) =>
    isRetiredPnpmGenerationOfInstall({ entrypoint: path.join(root, "dist/index.js"), activeRoot });
  await expect(check(retired)).resolves.toBe(true);
  await expect(
    check(
      path.join(
        home,
        "foreign/global/v11/active/node_modules/.pnpm/openclaw@2026.9.37/node_modules/openclaw",
      ),
    ),
  ).resolves.toBe(false);
  await expect(check(activeRoot)).resolves.toBe(false);
  await fs.mkdir(retired, { recursive: true });
  await expect(check(retired)).resolves.toBe(false);
});
