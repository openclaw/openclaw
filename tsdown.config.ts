import { defineConfig } from "tsdown";

const env = {
  NODE_ENV: "production",
};

export default defineConfig([
  {
    entry: "src/index.ts",
    env,
    fixedExtension: false,
    platform: "node",
    external: ["@reflink/reflink", /^@reflink\/reflink-/],
    inlineOnly: false,
  },
  {
    entry: "src/entry.ts",
    env,
    fixedExtension: false,
    platform: "node",
    external: ["@reflink/reflink", /^@reflink\/reflink-/],
    inlineOnly: false,
  },
  {
    // Ensure this module is bundled as an entry so legacy CLI shims can resolve its exports.
    entry: "src/cli/daemon-cli.ts",
    env,
    fixedExtension: false,
    platform: "node",
    external: ["@reflink/reflink", /^@reflink\/reflink-/],
    inlineOnly: false,
  },
  {
    entry: "src/infra/warning-filter.ts",
    env,
    fixedExtension: false,
    platform: "node",
    external: ["@reflink/reflink", /^@reflink\/reflink-/],
    inlineOnly: false,
  },
  {
    entry: "src/plugin-sdk/index.ts",
    outDir: "dist/plugin-sdk",
    env,
    fixedExtension: false,
    platform: "node",
    external: ["@reflink/reflink", /^@reflink\/reflink-/],
    inlineOnly: false,
  },
  {
    entry: "src/plugin-sdk/account-id.ts",
    outDir: "dist/plugin-sdk",
    env,
    fixedExtension: false,
    platform: "node",
    external: ["@reflink/reflink", /^@reflink\/reflink-/],
    inlineOnly: false,
  },
  {
    entry: "src/extensionAPI.ts",
    env,
    fixedExtension: false,
    platform: "node",
    external: ["@reflink/reflink", /^@reflink\/reflink-/],
    inlineOnly: false,
  },
  {
    entry: ["src/hooks/bundled/*/handler.ts", "src/hooks/llm-slug-generator.ts"],
    env,
    fixedExtension: false,
    platform: "node",
    external: ["@reflink/reflink", /^@reflink\/reflink-/],
    inlineOnly: false,
  },
]);
