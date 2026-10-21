import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { ensureDependencyLink } from "./plugin-generation-links.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

function makePackage(root: string, name: string): string {
  const pkg = path.join(root, name);
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name }));
  return pkg;
}

it("creates a junction when the link path is absent", () => {
  const root = dirs.make("link-absent-");
  const target = makePackage(root, "target-package");
  const link = path.join(root, "consumer", "node_modules", "target-package");

  expect(ensureDependencyLink(link, target)).toBe("created");
  expect(fs.realpathSync(link)).toBe(fs.realpathSync(target));
});

it("reuses an existing valid link", () => {
  const root = dirs.make("link-valid-");
  const target = makePackage(root, "target-package");
  const link = path.join(root, "consumer", "node_modules", "target-package");
  expect(ensureDependencyLink(link, target)).toBe("created");

  expect(ensureDependencyLink(link, target)).toBe("reused");
  expect(fs.realpathSync(link)).toBe(fs.realpathSync(target));
});

it("replaces a dangling link instead of failing with EEXIST", () => {
  const root = dirs.make("link-dangling-");
  const target = makePackage(root, "target-package");
  const disposed = path.join(root, "disposed-capture", "target-package");
  const link = path.join(root, "consumer", "node_modules", "target-package");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(disposed, link, "junction");
  expect(fs.existsSync(link)).toBe(false); // existsSync follows the dangling junction

  expect(ensureDependencyLink(link, target)).toBe("replaced");
  expect(fs.realpathSync(link)).toBe(fs.realpathSync(target));
});

it("reuses a real (non-link) dependency directory", () => {
  const root = dirs.make("link-real-");
  const target = makePackage(root, "target-package");
  const link = path.join(root, "consumer", "node_modules", "target-package");
  makePackage(path.join(root, "consumer", "node_modules"), "target-package");

  expect(ensureDependencyLink(link, target)).toBe("reused");
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(false);
});

it("tolerates a racing creator that wins with EEXIST", () => {
  const root = dirs.make("link-race-");
  const target = makePackage(root, "target-package");
  const link = path.join(root, "consumer", "node_modules", "target-package");
  fs.mkdirSync(path.dirname(link), { recursive: true });

  const realSymlink = fs.symlinkSync;
  const spy = vi.spyOn(fs, "symlinkSync").mockImplementation(((existingTarget, existingLink, type) => {
    // Another capture root wins the race before we create ours.
    realSymlink(existingTarget, existingLink, type);
    const error = new Error("EEXIST: file already exists") as NodeJS.ErrnoException;
    error.code = "EEXIST";
    throw error;
  }) as typeof fs.symlinkSync);

  try {
    expect(ensureDependencyLink(link, target)).toBe("reused");
  } finally {
    spy.mockRestore();
  }
  expect(fs.realpathSync(link)).toBe(fs.realpathSync(target));
});
