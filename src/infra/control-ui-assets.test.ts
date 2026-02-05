import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveControlUiDistIndexPath,
  resolveControlUiRepoRoot,
  resolveControlUiRootOverrideSync,
  resolveControlUiRootSync,
} from "./control-ui-assets.js";

describe("control UI assets helpers", () => {
  it("resolves repo root from src argv1", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-"));
    try {
      await fs.mkdir(path.join(tmp, "ui"), { recursive: true });
      await fs.writeFile(path.join(tmp, "ui", "vite.config.ts"), "export {};\n");
      await fs.writeFile(path.join(tmp, "package.json"), "{}\n");
      await fs.mkdir(path.join(tmp, "src"), { recursive: true });
      await fs.writeFile(path.join(tmp, "src", "index.ts"), "export {};\n");

      expect(resolveControlUiRepoRoot(path.join(tmp, "src", "index.ts"))).toBe(tmp);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("resolves repo root from dist argv1", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-"));
    try {
      await fs.mkdir(path.join(tmp, "ui"), { recursive: true });
      await fs.writeFile(path.join(tmp, "ui", "vite.config.ts"), "export {};\n");
      await fs.writeFile(path.join(tmp, "package.json"), "{}\n");
      await fs.mkdir(path.join(tmp, "dist"), { recursive: true });
      await fs.writeFile(path.join(tmp, "dist", "index.js"), "export {};\n");

      expect(resolveControlUiRepoRoot(path.join(tmp, "dist", "index.js"))).toBe(tmp);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("resolves dist control-ui index path for dist argv1", async () => {
    const argv1 = path.resolve("/tmp", "pkg", "dist", "index.js");
    const distDir = path.dirname(argv1);
    expect(await resolveControlUiDistIndexPath(argv1)).toBe(
      path.join(distDir, "control-ui", "index.html"),
    );
  });

  it("resolves control-ui root for dist bundle argv1", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-"));
    try {
      await fs.mkdir(path.join(tmp, "dist", "control-ui"), { recursive: true });
      await fs.writeFile(path.join(tmp, "dist", "bundle.js"), "export {};\n");
      await fs.writeFile(path.join(tmp, "dist", "control-ui", "index.html"), "<html></html>\n");

      expect(resolveControlUiRootSync({ argv1: path.join(tmp, "dist", "bundle.js") })).toBe(
        path.join(tmp, "dist", "control-ui"),
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("resolves control-ui root for dist/gateway bundle argv1", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-"));
    try {
      await fs.writeFile(path.join(tmp, "package.json"), JSON.stringify({ name: "openclaw" }));
      await fs.mkdir(path.join(tmp, "dist", "gateway"), { recursive: true });
      await fs.mkdir(path.join(tmp, "dist", "control-ui"), { recursive: true });
      await fs.writeFile(path.join(tmp, "dist", "gateway", "control-ui.js"), "export {};\n");
      await fs.writeFile(path.join(tmp, "dist", "control-ui", "index.html"), "<html></html>\n");

      expect(
        resolveControlUiRootSync({ argv1: path.join(tmp, "dist", "gateway", "control-ui.js") }),
      ).toBe(path.join(tmp, "dist", "control-ui"));
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("resolves control-ui root from override directory or index.html", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-"));
    try {
      const uiDir = path.join(tmp, "dist", "control-ui");
      await fs.mkdir(uiDir, { recursive: true });
      await fs.writeFile(path.join(uiDir, "index.html"), "<html></html>\n");

      expect(resolveControlUiRootOverrideSync(uiDir)).toBe(uiDir);
      expect(resolveControlUiRootOverrideSync(path.join(uiDir, "index.html"))).toBe(uiDir);
      expect(resolveControlUiRootOverrideSync(path.join(uiDir, "missing.html"))).toBeNull();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("resolves dist control-ui index path from package root argv1", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-"));
    try {
      await fs.writeFile(path.join(tmp, "package.json"), JSON.stringify({ name: "openclaw" }));
      await fs.writeFile(path.join(tmp, "openclaw.mjs"), "export {};\n");
      await fs.mkdir(path.join(tmp, "dist", "control-ui"), { recursive: true });
      await fs.writeFile(path.join(tmp, "dist", "control-ui", "index.html"), "<html></html>\n");

      expect(await resolveControlUiDistIndexPath(path.join(tmp, "openclaw.mjs"))).toBe(
        path.join(tmp, "dist", "control-ui", "index.html"),
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("resolves control-ui root for package entrypoint argv1", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-"));
    try {
      await fs.writeFile(path.join(tmp, "package.json"), JSON.stringify({ name: "openclaw" }));
      await fs.writeFile(path.join(tmp, "openclaw.mjs"), "export {};\n");
      await fs.mkdir(path.join(tmp, "dist", "control-ui"), { recursive: true });
      await fs.writeFile(path.join(tmp, "dist", "control-ui", "index.html"), "<html></html>\n");

      expect(resolveControlUiRootSync({ argv1: path.join(tmp, "openclaw.mjs") })).toBe(
        path.join(tmp, "dist", "control-ui"),
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("resolves dist control-ui index path from .bin argv1", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-"));
    try {
      const binDir = path.join(tmp, "node_modules", ".bin");
      const pkgRoot = path.join(tmp, "node_modules", "openclaw");
      await fs.mkdir(binDir, { recursive: true });
      await fs.mkdir(path.join(pkgRoot, "dist", "control-ui"), { recursive: true });
      await fs.writeFile(path.join(binDir, "openclaw"), "#!/usr/bin/env node\n");
      await fs.writeFile(path.join(pkgRoot, "package.json"), JSON.stringify({ name: "openclaw" }));
      await fs.writeFile(path.join(pkgRoot, "dist", "control-ui", "index.html"), "<html></html>\n");

      expect(await resolveControlUiDistIndexPath(path.join(binDir, "openclaw"))).toBe(
        path.join(pkgRoot, "dist", "control-ui", "index.html"),
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
