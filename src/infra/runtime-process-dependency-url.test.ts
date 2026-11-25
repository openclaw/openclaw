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

function installedDependency(packageName: string, relativeEntry: string, label: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-dependency-owner-"));
  roots.push(root);
  const packageRoot = path.join(root, "node_modules", packageName);
  const entry = path.join(packageRoot, relativeEntry);
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: packageName }));
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
      const { root, entry } = installedDependency(
        "chrome-devtools-mcp",
        "build/src/bin/chrome-devtools-mcp.js",
        label,
      );
      const resolved = resolveRuntimeDependencyEntrypointUrl(
        "chromeDevtoolsMcp",
        pathToFileURL(path.join(root, "caller.mjs")).href,
      );
      expect(fileURLToPath(resolved)).toBe(entry);
      expect(fs.readFileSync(resolved, "utf8")).toBe(label);
    }
  },
);

it.each(["ordinary", "aot"] as const)(
  "keeps an explicitly selected dependency directory in an %s host",
  async (host) => {
    if (host === "aot") {
      vi.stubGlobal("__openclawStandaloneRootUrl", pathToFileURL("/other-runtime/").href);
    }
    const { resolveRuntimeDependencyEntrypointUrlFromDirectory } =
      await import("./runtime-process-dependency-url.js");
    for (const [name, relativeEntry] of [
      ["npm", "custom/bin/npm-cli.js"],
      ["npx", "custom/bin/npx-cli.js"],
    ] as const) {
      for (const label of ["first owner", "second owner"]) {
        const { entry } = installedDependency("npm", relativeEntry, label);
        const resolved = resolveRuntimeDependencyEntrypointUrlFromDirectory(
          name,
          path.dirname(entry),
        );
        expect(fileURLToPath(resolved)).toBe(entry);
        expect(fs.readFileSync(resolved, "utf8")).toBe(label);
      }
    }
  },
);

it.each(["npm", "npx"] as const)("resolves %s through its package layout", async (name) => {
  const { resolveRuntimeDependencyEntrypointUrl } =
    await import("./runtime-process-dependency-url.js");
  const { root, entry } = installedDependency("npm", `bin/${name}-cli.js`, "selected program");
  const resolved = resolveRuntimeDependencyEntrypointUrl(
    name,
    pathToFileURL(path.join(root, "caller.mjs")).href,
  );
  expect(fileURLToPath(resolved)).toBe(entry);
});
