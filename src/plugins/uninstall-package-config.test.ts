import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasMatchingPluginLoadPath } from "./uninstall-package-config.js";

let previousHome: string | undefined;
let home: string;

beforeEach(() => {
  previousHome = process.env.OPENCLAW_HOME;
  home = path.join(os.tmpdir(), "openclaw-uninstall-home");
  process.env.OPENCLAW_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.OPENCLAW_HOME;
  } else {
    process.env.OPENCLAW_HOME = previousHome;
  }
});

function configWithLoadPaths(loadPaths: string[]): OpenClawConfig {
  return { plugins: { load: { paths: loadPaths } } };
}

function installPath(): string {
  return path.join(home, "plugins", "demo-tilde");
}

describe("hasMatchingPluginLoadPath", () => {
  it("matches the documented home-relative form against the absolute install path", () => {
    // `~/plugins/<id>` is the form the plugin docs use. Comparing it verbatim treats
    // `~` as a literal directory name, so uninstall never removed the entry.
    expect(
      hasMatchingPluginLoadPath(configWithLoadPaths(["~/plugins/demo-tilde"]), [installPath()]),
    ).toBe(true);
  });

  it("keeps matching absolute load paths", () => {
    expect(hasMatchingPluginLoadPath(configWithLoadPaths([installPath()]), [installPath()])).toBe(
      true,
    );
  });

  it("does not match a different home-relative plugin", () => {
    expect(
      hasMatchingPluginLoadPath(configWithLoadPaths(["~/plugins/other-plugin"]), [installPath()]),
    ).toBe(false);
  });
});
