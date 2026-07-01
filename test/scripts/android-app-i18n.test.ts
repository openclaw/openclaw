import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { checkAndroidAppI18n } from "../../scripts/android-app-i18n.ts";

describe("Android app i18n resources", () => {
  it("keeps every native locale resource key aligned with English", async () => {
    await expect(checkAndroidAppI18n()).resolves.toBeUndefined();
  });

  it("preserves the existing Swedish app name", async () => {
    const strings = await readFile("apps/android/app/src/main/res/values-sv/strings.xml", "utf8");
    expect(strings).toContain('<string name="app_name">OpenClaw-nod</string>');
  });
});
