import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import react from "@vitejs/plugin-react";
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
  optimizeDeps: {
    exclude: [
      "langium",
      "vscode-languageserver-types",
      "vscode-languageserver-protocol",
      "vscode-jsonrpc",
      "@chevrotain/regexp-to-ast",
    ],
  },
  build: {
    outDir: path.resolve(here, "../dist/control-ui-next"),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      external: [/^vscode-languageserver/, /^langium/],
      output: {
        manualChunks(id) {
          // Pixel-engine — lazy-loaded with Visualize page
          if (id.includes("lib/pixel-engine")) {
            return "pixel-engine";
          }
          // Core React + router — shared by all pages
          if (
            id.includes("node_modules/react/") ||
            id.includes("node_modules/react-dom/") ||
            id.includes("node_modules/react-router-dom/")
          ) {
            return "vendor-react";
          }
          // Zustand state management
          if (id.includes("node_modules/zustand/")) {
            return "vendor-zustand";
          }
          // Radix UI primitives — shared by all shadcn components
          if (
            id.includes("node_modules/radix-ui/") ||
            id.includes("node_modules/class-variance-authority/") ||
            id.includes("node_modules/clsx/") ||
            id.includes("node_modules/tailwind-merge/")
          ) {
            return "vendor-radix";
          }
          // Markdown rendering — only loaded by chat page
          if (
            id.includes("node_modules/react-markdown/") ||
            id.includes("node_modules/remark-gfm/")
          ) {
            return "vendor-markdown";
          }
          // Shiki syntax highlighting — heavy, only loaded by chat page
          if (id.includes("node_modules/shiki/")) {
            return "vendor-shiki";
          }
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
