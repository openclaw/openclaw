import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "tsdown";

const env = {
  NODE_ENV: "production",
};

type Entry = Parameters<typeof defineConfig>[0][number];

const baseEntries: Entry[] = [
  {
    entry: "src/index.ts",
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: "src/entry.ts",
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: "src/infra/warning-filter.ts",
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: "src/plugin-sdk/index.ts",
    outDir: "dist/plugin-sdk",
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: "src/extensionAPI.ts",
    env,
    fixedExtension: false,
    platform: "node",
  },
];

const bundledHookEntries = createBundledHookEntries();

export default defineConfig([...baseEntries, ...bundledHookEntries]);

function createBundledHookEntries(): Entry[] {
  const entries: Entry[] = [];
  const bundledDir = path.join(process.cwd(), "src", "hooks", "bundled");

  if (!fs.existsSync(bundledDir)) {
    return entries;
  }

  for (const dirent of fs.readdirSync(bundledDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }

    const handlerRelative = path.join("src", "hooks", "bundled", dirent.name, "handler.ts");
    const handlerAbsolute = path.join(process.cwd(), handlerRelative);

    if (!fs.existsSync(handlerAbsolute)) {
      continue;
    }

    entries.push({
      entry: handlerRelative,
      outDir: path.join("dist", "hooks", "bundled", dirent.name),
      env,
      fixedExtension: false,
      platform: "node",
    });
  }

  return entries;
}
