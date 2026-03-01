import { defineConfig } from "tsdown";

export default defineConfig({
  entry: "src/entry.ts",
  env: {
    NODE_ENV: "production",
  },
  platform: "node",
  format: "esm",
  outDir: "dist",
  hash: false,
  clean: false,
  fixedExtension: false,
  outputOptions: (options) => ({
    ...options,
    entryFileNames: "entry.bundle.mjs",
    inlineDynamicImports: true,
  }),
});
