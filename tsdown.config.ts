import { defineConfig } from "tsdown";

const env = {
  NODE_ENV: "production",
};

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      entry: "src/entry.ts",
      extensionAPI: "src/extensionAPI.ts",
    },
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: {
      index: "src/plugin-sdk/index.ts",
    },
    outDir: "dist/plugin-sdk",
    env,
    fixedExtension: false,
    platform: "node",
  },
]);
