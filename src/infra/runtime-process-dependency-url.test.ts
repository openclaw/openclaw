import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function installedChrome(label: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-dependency-owner-"));
  roots.push(root);
  const packageRoot = path.join(root, "node_modules", "chrome-devtools-mcp");
  const entry = path.join(packageRoot, "build", "src", "bin", "chrome-devtools-mcp.js");
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "chrome-devtools-mcp" }),
  );
  fs.writeFileSync(entry, label);
  return { root, entry };
}

it.each(["ordinary", "aot"] as const)(
  "resolves a declared dependency from each caller's package tree in an %s host",
  async (host) => {
    if (host === "aot") {
      vi.stubGlobal("__openclawStandaloneBuildInfo", { mode: "aot" });
    }
    const { resolveRuntimeDependencyEntrypointUrl } =
      await import("./runtime-process-dependency-url.js");
    for (const label of ["first owner", "second owner"]) {
      const { root, entry } = installedChrome(label);
      const resolved = resolveRuntimeDependencyEntrypointUrl(
        "chromeDevtoolsMcp",
        pathToFileURL(path.join(root, "caller.mjs")).href,
      );
      expect(fileURLToPath(resolved)).toBe(entry);
      expect(fs.readFileSync(resolved, "utf8")).toBe(label);
    }
  },
);
