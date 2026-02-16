import { defineConfig } from "astro/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function normalizeBase(input) {
  const trimmed = input.trim();
  if (!trimmed) {
    return "/";
  }
  if (trimmed === "./") {
    return "./";
  }
  if (trimmed.endsWith("/")) {
    return trimmed;
  }
  return `${trimmed}/`;
}

const envBase = process.env.OPENCLAW_CONTROL_UI_BASE_PATH?.trim();
const base = envBase ? normalizeBase(envBase) : "./";

// https://docs.astro.build/en/reference/configuration-reference/
export default defineConfig({
  base,
  publicDir: path.resolve(here, "public"),

  vite: {
    resolve: {
      alias: {
        "@": path.resolve(here, "src"),
        "@ui": path.resolve(here, "src/ui"),
      },
    },
    optimizeDeps: {
      include: ["lit/directives/repeat.js"],
    },
  },

  outDir: path.resolve(here, "../dist/control-ui"),

  server: {
    host: true,
    port: 5173,
  },

  output: "static",
});
