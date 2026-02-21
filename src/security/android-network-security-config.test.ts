import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();
const MAIN_CONFIG_PATH = path.join(
  REPO_ROOT,
  "apps/android/app/src/main/res/xml/network_security_config.xml",
);
const DEBUG_CONFIG_PATH = path.join(
  REPO_ROOT,
  "apps/android/app/src/debug/res/xml/network_security_config.xml",
);

describe("android network security config", () => {
  it("disables global cleartext traffic in main (release) config", async () => {
    const xml = await fs.readFile(MAIN_CONFIG_PATH, "utf-8");

    expect(xml.includes('cleartextTrafficPermitted="true"')).toBe(false);
    expect(xml).toContain('<base-config cleartextTrafficPermitted="false" />');
  });

  it("keeps cleartext override scoped to debug config only", async () => {
    const xml = await fs.readFile(DEBUG_CONFIG_PATH, "utf-8");

    expect(xml).toContain('<base-config cleartextTrafficPermitted="true"');
    expect(xml).toContain('tools:ignore="InsecureBaseConfiguration"');
  });
});
