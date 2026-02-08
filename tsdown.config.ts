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
  // Bundled hook handlers — compiled so npm installs include handler.js.  #11810
  {
    entry: {
      "hooks/bundled/boot-md/handler": "src/hooks/bundled/boot-md/handler.ts",
      "hooks/bundled/command-logger/handler": "src/hooks/bundled/command-logger/handler.ts",
      "hooks/bundled/session-memory/handler": "src/hooks/bundled/session-memory/handler.ts",
      "hooks/bundled/soul-evil/handler": "src/hooks/bundled/soul-evil/handler.ts",
    },
    env,
    fixedExtension: false,
    platform: "node",
  },
]);
