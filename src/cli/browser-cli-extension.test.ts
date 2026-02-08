import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const copyToClipboard = vi.fn();
const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

vi.mock("../infra/clipboard.js", () => ({
  copyToClipboard,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: runtime,
}));

function writeManifest(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ manifest_version: 3 }));
}

describe("bundled extension resolver", () => {
  it("walks up to find the assets directory", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ext-root-"));
    const here = path.join(root, "dist", "cli");
    const assets = path.join(root, "assets", "chrome-extension");

    try {
      writeManifest(assets);
      fs.mkdirSync(here, { recursive: true });

      const { resolveBundledExtensionRootDir } = await import("./browser-cli-extension.js");
      expect(resolveBundledExtensionRootDir(here)).toBe(assets);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefers the nearest assets directory", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ext-root-"));
    const here = path.join(root, "dist", "cli");
    const distAssets = path.join(root, "dist", "assets", "chrome-extension");
    const rootAssets = path.join(root, "assets", "chrome-extension");

    try {
      writeManifest(distAssets);
      writeManifest(rootAssets);
      fs.mkdirSync(here, { recursive: true });

      const { resolveBundledExtensionRootDir } = await import("./browser-cli-extension.js");
      expect(resolveBundledExtensionRootDir(here)).toBe(distAssets);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds assets/chrome-extension in npm package root (issue #10048)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-npm-"));
    const here = path.join(root, "dist", "cli");
    const assets = path.join(root, "assets", "chrome-extension");

    try {
      // Simulate npm package structure: package.json at root, dist/ and assets/ as siblings
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
      writeManifest(assets);
      fs.mkdirSync(here, { recursive: true });

      const { resolveBundledExtensionRootDir } = await import("./browser-cli-extension.js");
      const resolved = resolveBundledExtensionRootDir(here);

      expect(resolved).toBe(assets);
      expect(fs.existsSync(path.join(resolved, "manifest.json"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips workspace root package.json and finds openclaw package (monorepo)", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-"));
    const openclawRoot = path.join(workspaceRoot, "packages", "openclaw");
    const here = path.join(openclawRoot, "dist", "cli");
    const assets = path.join(openclawRoot, "assets", "chrome-extension");

    try {
      // Create workspace structure:
      // workspace/
      //   package.json (name: "my-workspace")
      //   packages/
      //     openclaw/
      //       package.json (name: "openclaw")
      //       dist/cli/
      //       assets/chrome-extension/

      fs.writeFileSync(
        path.join(workspaceRoot, "package.json"),
        JSON.stringify({ name: "my-workspace", workspaces: ["packages/*"] }),
      );

      fs.mkdirSync(here, { recursive: true });
      fs.writeFileSync(
        path.join(openclawRoot, "package.json"),
        JSON.stringify({ name: "openclaw" }),
      );
      writeManifest(assets);

      const { resolveBundledExtensionRootDir } = await import("./browser-cli-extension.js");
      const resolved = resolveBundledExtensionRootDir(here);

      // Should resolve to openclaw's assets, not workspace root
      expect(resolved).toBe(assets);
      // Verify path contains "openclaw" (works on both Windows and Unix)
      expect(resolved.includes("openclaw")).toBe(true);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("browser extension install", () => {
  it("installs into the state dir (never node_modules)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ext-"));

    try {
      const { installChromeExtension } = await import("./browser-cli-extension.js");
      const sourceDir = path.resolve(process.cwd(), "assets/chrome-extension");
      const result = await installChromeExtension({ stateDir: tmp, sourceDir });

      expect(result.path).toBe(path.join(tmp, "browser", "chrome-extension"));
      expect(fs.existsSync(path.join(result.path, "manifest.json"))).toBe(true);
      expect(result.path.includes("node_modules")).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("copies extension path to clipboard", async () => {
    const prev = process.env.OPENCLAW_STATE_DIR;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ext-path-"));
    process.env.OPENCLAW_STATE_DIR = tmp;

    try {
      copyToClipboard.mockReset();
      copyToClipboard.mockResolvedValue(true);
      runtime.log.mockReset();
      runtime.error.mockReset();
      runtime.exit.mockReset();

      const dir = path.join(tmp, "browser", "chrome-extension");
      writeManifest(dir);

      vi.resetModules();
      const { Command } = await import("commander");
      const { registerBrowserExtensionCommands } = await import("./browser-cli-extension.js");

      const program = new Command();
      const browser = program.command("browser").option("--json", false);
      registerBrowserExtensionCommands(
        browser,
        (cmd) => cmd.parent?.opts?.() as { json?: boolean },
      );

      await program.parseAsync(["browser", "extension", "path"], { from: "user" });

      expect(copyToClipboard).toHaveBeenCalledWith(dir);
    } finally {
      if (prev === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = prev;
      }
    }
  });
});
