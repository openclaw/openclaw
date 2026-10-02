import { existsSync, mkdirSync, renameSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createToolingDependencyFixture } from "./tooling-dependencies.test-support.mts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("bootstraps the opted-in entrypoint without linking dependencies", () => {
  const fixture = createToolingDependencyFixture(tempDirs.make("openclaw-tooling-bootstrap-"));
  const result = fixture.run();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("qualified bootstrap OK\n");
  expect(existsSync(join(fixture.checkout, "node_modules"))).toBe(false);

  const ordinary = fixture.run("ordinary.mjs");
  expect(ordinary.status).toBe(1);
  expect(ordinary.stderr).toContain("Repository dependencies are missing");
  expect(ordinary.stdout).toBe("");
  expect(existsSync(join(fixture.checkout, "node_modules"))).toBe(false);
});

it.each(["tsx", "fixture-pkg"])("rejects stale %s before executing its source", (name) => {
  const fixture = createToolingDependencyFixture(tempDirs.make("openclaw-tooling-version-"));
  fixture.writePackage(name, 'console.log("STALE PACKAGE EXECUTED");', "0.0.0-stale");
  const result = fixture.run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`'${name}' has version 0.0.0-stale`);
  expect(result.stderr).toContain("requires 1.0.0");
  expect(result.stderr.trimEnd()).toMatch(/\[crabbox\] FAILED \(exit 1\)$/);
  expect(result.stdout + result.stderr).not.toContain("STALE PACKAGE EXECUTED");
  expect(existsSync(join(fixture.checkout, "node_modules"))).toBe(false);
});

it.each(["tsx", "fixture-pkg"])("refuses %s linked to another checkout's source", (name) => {
  const root = tempDirs.make("openclaw-tooling-workspace-");
  const fixture = createToolingDependencyFixture(root);
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const installed = join(fixture.tooling, "node_modules", name);
  const external = join(workspace, name);
  renameSync(installed, external);
  symlinkSync(external, installed, process.platform === "win32" ? "junction" : "dir");
  const result = fixture.run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Tooling package escapes its installed dependency owner");
  expect(result.stdout).toBe("");
  expect(existsSync(join(fixture.checkout, "node_modules"))).toBe(false);
});
