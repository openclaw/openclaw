import { defineConfig } from "tsdown";

const env = {
  NODE_ENV: "production",
  POSTHOG_KEY: process.env.POSTHOG_KEY || "",
};

export default defineConfig([
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
    entry: "src/cli/flatten-standalone-deps.ts",
    env,
    fixedExtension: false,
    platform: "node",
  },
]);
