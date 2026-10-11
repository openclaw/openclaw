import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveGatewayProgramArguments } from "./program-args.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

/** Writes a versioned pnpm store package under an isolated install root. */
async function writeStorePackage(installRoot: string, version: string) {
  const storeRoot = path.join(
    installRoot,
    "node_modules",
    ".pnpm",
    `openclaw@${version}`,
    "node_modules",
    "openclaw",
  );
  await fs.mkdir(path.join(storeRoot, "dist"), { recursive: true });
  await fs.writeFile(
    path.join(storeRoot, "package.json"),
    JSON.stringify({ name: "openclaw", version }),
  );
  await fs.writeFile(path.join(storeRoot, "openclaw.mjs"), 'import "./dist/index.js";\n');
  await fs.writeFile(path.join(storeRoot, "dist", "index.js"), `export default "${version}";\n`);
  const packageLink = path.join(installRoot, "node_modules", "openclaw");
  await fs.mkdir(path.dirname(packageLink), { recursive: true });
  await fs.symlink(storeRoot, packageLink, "dir");
}

/**
 * Builds a pnpm 12 global/v11 isolated install: a per-install generation
 * project (…/global/v11/<project>) whose node_modules/openclaw package link
 * points into the versioned .pnpm store, plus a durable hash symlink
 * (…/global/v11/<hash>) that pnpm retargets to each replacement generation.
 */
async function createV11Install() {
  const home = tempDirs.make("openclaw-v11-");
  const globalRoot = path.join(home, "pnpm", "global", "v11");
  const installRoot = path.join(globalRoot, "openclaw-abc123-0");
  const hashLink = path.join(globalRoot, "926ea0a5");
  await writeStorePackage(installRoot, "2026.10.1");
  await fs.writeFile(
    path.join(installRoot, "package.json"),
    JSON.stringify({ private: true, dependencies: { openclaw: "2026.10.1" } }),
  );
  await fs.writeFile(path.join(installRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await fs.symlink(installRoot, hashLink, "dir");
  return { home, globalRoot, installRoot, hashLink };
}

describe("pnpm 12 global/v11 Gateway entrypoint", () => {
  it("pins the unit entrypoint to the durable hash-link path, not the replaceable generation", async () => {
    const f = await createV11Install();
    // The pnpm shim invokes the CLI through the durable hash link.
    const cliEntrypoint = path.join(f.hashLink, "node_modules", "openclaw", "openclaw.mjs");
    const resolved = await resolveGatewayProgramArguments({
      cliEntrypoint,
      runtime: "node",
      runtimePath: process.execPath,
      port: 18789,
    });
    const entry = resolved.programArguments.at(-4);
    // Durable path: global/v11/<hash>/node_modules/openclaw/dist/index.js
    expect(entry).toBe(path.join(f.hashLink, "node_modules", "openclaw", "dist", "index.js"));
    expect(entry).not.toContain(".pnpm");
    expect(entry).not.toContain(f.installRoot);
    // The planned entrypoint exists right now.
    await expect(fs.readFile(entry!, "utf8")).resolves.toBe('export default "2026.10.1";\n');
  });

  it("keeps the planned entrypoint usable after pnpm replaces the generation project", async () => {
    const f = await createV11Install();
    const cliEntrypoint = path.join(f.hashLink, "node_modules", "openclaw", "openclaw.mjs");
    const resolved = await resolveGatewayProgramArguments({
      cliEntrypoint,
      runtime: "node",
      runtimePath: process.execPath,
      port: 18789,
    });
    const entry = resolved.programArguments.at(-4);
    expect(entry).not.toContain(".pnpm");

    // Simulate a pnpm update: write a replacement generation project, retarget
    // the durable hash link to it, and remove the retired generation directory.
    const replacementRoot = path.join(f.globalRoot, "openclaw-def456-0");
    await writeStorePackage(replacementRoot, "2026.10.2");
    await fs.writeFile(
      path.join(replacementRoot, "package.json"),
      JSON.stringify({ private: true, dependencies: { openclaw: "2026.10.2" } }),
    );
    await fs.writeFile(path.join(replacementRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await fs.rm(f.hashLink, { recursive: true });
    await fs.symlink(replacementRoot, f.hashLink, "dir");
    await fs.rm(f.installRoot, { recursive: true });

    // The planned durable path still resolves to the replacement's entrypoint.
    await expect(fs.readFile(entry!, "utf8")).resolves.toBe('export default "2026.10.2";\n');
  });
});
