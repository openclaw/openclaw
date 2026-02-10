import { defineConfig } from "tsdown";

const env = {
  NODE_ENV: "production",
};

// Do not clean outDir before build so dist/data/ (and dist/data/skills.json) persist during
// the build window; copy-skills-data.ts overwrites skills.json at the end. Avoids ENOENT
// when the gateway or cron runs while pnpm build is in progress.
const noClean = { clean: false as const };

export default defineConfig([
  {
    entry: "src/index.ts",
    env,
    fixedExtension: false,
    platform: "node",
    ...noClean,
  },
  {
    entry: "src/entry.ts",
    env,
    fixedExtension: false,
    platform: "node",
    ...noClean,
  },
  {
    entry: "src/infra/warning-filter.ts",
    env,
    fixedExtension: false,
    platform: "node",
    ...noClean,
  },
  {
    entry: "src/plugin-sdk/index.ts",
    outDir: "dist/plugin-sdk",
    env,
    fixedExtension: false,
    platform: "node",
    ...noClean,
  },
  {
    entry: "src/extensionAPI.ts",
    env,
    fixedExtension: false,
    platform: "node",
    ...noClean,
  },
  {
    entry: ["src/hooks/bundled/*/handler.ts", "src/hooks/llm-slug-generator.ts"],
    env,
    fixedExtension: false,
    platform: "node",
    ...noClean,
  },
]);
