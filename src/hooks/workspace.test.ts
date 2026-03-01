import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import { loadHookEntriesFromDir } from "./workspace.js";

describe("hooks workspace", () => {
  it("ignores package.json hook paths that traverse outside package directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hooks-workspace-"));
    const hooksRoot = path.join(root, "hooks");
    fs.mkdirSync(hooksRoot, { recursive: true });

    const pkgDir = path.join(hooksRoot, "pkg");
    fs.mkdirSync(pkgDir, { recursive: true });

    const outsideHookDir = path.join(root, "outside");
    fs.mkdirSync(outsideHookDir, { recursive: true });
    fs.writeFileSync(path.join(outsideHookDir, "HOOK.md"), "---\nname: outside\n---\n");
    fs.writeFileSync(path.join(outsideHookDir, "handler.js"), "export default async () => {};\n");

    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify(
        {
          name: "pkg",
          [MANIFEST_KEY]: {
            hooks: ["../outside"],
          },
        },
        null,
        2,
      ),
    );

    const entries = loadHookEntriesFromDir({ dir: hooksRoot, source: "openclaw-workspace" });
    expect(entries.some((e) => e.hook.name === "outside")).toBe(false);
  });

  it("accepts package.json hook paths within package directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hooks-workspace-ok-"));
    const hooksRoot = path.join(root, "hooks");
    fs.mkdirSync(hooksRoot, { recursive: true });

    const pkgDir = path.join(hooksRoot, "pkg");
    const nested = path.join(pkgDir, "nested");
    fs.mkdirSync(nested, { recursive: true });

    fs.writeFileSync(path.join(nested, "HOOK.md"), "---\nname: nested\n---\n");
    fs.writeFileSync(path.join(nested, "handler.js"), "export default async () => {};\n");

    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify(
        {
          name: "pkg",
          [MANIFEST_KEY]: {
            hooks: ["./nested"],
          },
        },
        null,
        2,
      ),
    );

    const entries = loadHookEntriesFromDir({ dir: hooksRoot, source: "openclaw-workspace" });
    expect(entries.some((e) => e.hook.name === "nested")).toBe(true);
  });

  it("ignores package.json hook paths that escape via symlink", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hooks-workspace-link-"));
    const hooksRoot = path.join(root, "hooks");
    fs.mkdirSync(hooksRoot, { recursive: true });

    const pkgDir = path.join(hooksRoot, "pkg");
    const outsideDir = path.join(root, "outside");
    const linkedDir = path.join(pkgDir, "linked");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "HOOK.md"), "---\nname: outside\n---\n");
    fs.writeFileSync(path.join(outsideDir, "handler.js"), "export default async () => {};\n");
    try {
      fs.symlinkSync(outsideDir, linkedDir, process.platform === "win32" ? "junction" : "dir");
    } catch {
      return;
    }

    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify(
        {
          name: "pkg",
          [MANIFEST_KEY]: {
            hooks: ["./linked"],
          },
        },
        null,
        2,
      ),
    );

    const entries = loadHookEntriesFromDir({ dir: hooksRoot, source: "openclaw-workspace" });
    expect(entries.some((e) => e.hook.name === "outside")).toBe(false);
  });

  it("ignores hooks with hardlinked HOOK.md aliases", () => {
    if (process.platform === "win32") {
      return;
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hooks-workspace-hardlink-"));
    const hooksRoot = path.join(root, "hooks");
    fs.mkdirSync(hooksRoot, { recursive: true });

    const hookDir = path.join(hooksRoot, "hardlink-hook");
    const outsideDir = path.join(root, "outside");
    fs.mkdirSync(hookDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(hookDir, "handler.js"), "export default async () => {};\n");
    const outsideHookMd = path.join(outsideDir, "HOOK.md");
    const linkedHookMd = path.join(hookDir, "HOOK.md");
    fs.writeFileSync(linkedHookMd, "---\nname: hardlink-hook\n---\n");
    fs.rmSync(linkedHookMd);
    fs.writeFileSync(outsideHookMd, "---\nname: outside\n---\n");
    try {
      fs.linkSync(outsideHookMd, linkedHookMd);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        return;
      }
      throw err;
    }

    const entries = loadHookEntriesFromDir({ dir: hooksRoot, source: "openclaw-workspace" });
    expect(entries.some((e) => e.hook.name === "hardlink-hook")).toBe(false);
    expect(entries.some((e) => e.hook.name === "outside")).toBe(false);
  });

  it("ignores hooks with hardlinked handler aliases", () => {
    if (process.platform === "win32") {
      return;
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hooks-workspace-hardlink-"));
    const hooksRoot = path.join(root, "hooks");
    fs.mkdirSync(hooksRoot, { recursive: true });

    const hookDir = path.join(hooksRoot, "hardlink-handler-hook");
    const outsideDir = path.join(root, "outside");
    fs.mkdirSync(hookDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(hookDir, "HOOK.md"), "---\nname: hardlink-handler-hook\n---\n");
    const outsideHandler = path.join(outsideDir, "handler.js");
    const linkedHandler = path.join(hookDir, "handler.js");
    fs.writeFileSync(outsideHandler, "export default async () => {};\n");
    try {
      fs.linkSync(outsideHandler, linkedHandler);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        return;
      }
      throw err;
    }

    const entries = loadHookEntriesFromDir({ dir: hooksRoot, source: "openclaw-workspace" });
    expect(entries.some((e) => e.hook.name === "hardlink-handler-hook")).toBe(false);
  });
});
