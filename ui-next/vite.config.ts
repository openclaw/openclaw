import tailwindcss from "@tailwindcss/vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const rootPkg = JSON.parse(fs.readFileSync(path.resolve(here, "../package.json"), "utf-8"));

function normalizeBase(input: string | undefined): string | undefined {
  if (!input) {
    return undefined;
  }
  const trimmed = input.trim();
  if (!trimmed || trimmed === "./") {
    return "./";
  }
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

export default defineConfig({
  base: normalizeBase(process.env.OPENCLAW_CONTROL_UI_BASE_PATH) ?? "./",
  define: {
    __APP_VERSION__: JSON.stringify(rootPkg.version),
  },
  plugins: [react(), tailwindcss(), basicSsl()],
  resolve: {
    alias: {
      "@": path.resolve(here, "src"),
    },
  },
  build: {
    outDir: path.resolve(here, "../dist/control-ui-next"),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          // Core React + router — shared by all pages
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          // Zustand state management
          "vendor-zustand": ["zustand"],
          // Radix UI primitives — shared by all shadcn components
          "vendor-radix": ["radix-ui", "class-variance-authority", "clsx", "tailwind-merge"],
          // Markdown rendering — only loaded by chat page
          "vendor-markdown": ["react-markdown", "remark-gfm"],
          // Shiki syntax highlighting — heavy, only loaded by chat page
          "vendor-shiki": ["shiki"],
        },
      },
    },
  },
  server: {
    host: true,
    port: 5174,
    strictPort: true,
    proxy: {
      // Proxy WebSocket connections to the gateway so the browser only talks
      // to the Vite dev server origin — no cross-origin cert issues.
      "/gw-ws": {
        target: "https://localhost:18789",
        ws: true,
        secure: false, // accept the gateway's self-signed cert
        rewriteWsOrigin: true,
        rewrite: (p) => p.replace(/^\/gw-ws/, ""),
      },
    },
  },
});
