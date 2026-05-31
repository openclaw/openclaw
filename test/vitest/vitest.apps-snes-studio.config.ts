import { defineConfig } from "vitest/config";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

const config = createScopedVitestConfig(["apps/snes-studio/src/**/*.test.ts"], {
  name: "apps-snes-studio",
  includeOpenClawRuntimeSetup: false,
});

export default defineConfig({
  ...config,
  resolve: {
    alias: {
      "@openclaw/snes-studio-core": new URL(
        "../../packages/snes-studio-core/src/index.ts",
        import.meta.url,
      ).pathname,
    },
  },
});
