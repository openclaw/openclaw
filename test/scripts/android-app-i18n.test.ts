import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  checkAndroidAppI18n,
  findUnlocalizedAndroidUiLiterals,
  renderAndroidResourceValue,
  selectDeterministicTranslation,
} from "../../scripts/android-app-i18n.ts";

describe("Android app i18n resources", () => {
  it("keeps generated resources, runtime coverage, and every locale aligned", async () => {
    await expect(checkAndroidAppI18n()).resolves.toBeUndefined();
  });

  it("preserves the existing Swedish app name", async () => {
    const strings = await readFile("apps/android/app/src/main/res/values-sv/strings.xml", "utf8");
    expect(strings).toContain('<string name="app_name">OpenClaw-nod</string>');
  });

  it("selects duplicate-source translations by frequency then stable text order", () => {
    expect(selectDeterministicTranslation(["Beta", "Alpha", "Beta"])).toBe("Beta");
    expect(selectDeterministicTranslation(["Beta", "Alpha"])).toBe("Alpha");
  });

  it("preserves source argument indexes when a translation reorders interpolations", () => {
    expect(
      renderAndroidResourceValue(
        "$readyProviderCount of $providerCount providers ready",
        "$providerCount Anbieter, davon $readyProviderCount bereit",
      ),
    ).toBe("%2$s Anbieter, davon %1$s bereit");
  });

  it("finds direct UI literals but ignores localized calls and preview fixtures", () => {
    const source = `
      Text("Settings")
      Text(text = nativeStringResource("Connected"))
      ClawPrimaryButton(text = "Continue", onClick = {})
      ClawStatusPill(text = "Working")
      SettingsMetric("Gateway", gatewayName)
      val dynamic = Text(text = gateway.name)
    `;
    expect(
      findUnlocalizedAndroidUiLiterals(
        source,
        "apps/android/app/src/main/java/ai/openclaw/app/ui/Example.kt",
      ),
    ).toEqual([
      expect.objectContaining({ source: "Settings" }),
      expect.objectContaining({ source: "Continue" }),
      expect.objectContaining({ source: "Working" }),
      expect.objectContaining({ source: "Gateway" }),
    ]);
    expect(
      findUnlocalizedAndroidUiLiterals(
        'Text("Preview copy")',
        "apps/android/app/src/main/java/ai/openclaw/app/ui/design/ClawComponents.kt",
      ),
    ).toEqual([]);
  });
});
