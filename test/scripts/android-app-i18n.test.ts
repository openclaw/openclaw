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

  it("rejects repeated translation placeholders that do not match the source", () => {
    expect(() =>
      renderAndroidResourceValue("$item then $item", "$item, $item und noch einmal $item"),
    ).toThrow("Android translation changed interpolation placeholders");
  });

  it("finds direct, typed, conditional, interpolated, Elvis, and accessibility literals", () => {
    const source = `
      data class ConnectionState(
        val connected: Boolean,
        val statusText: String,
      )

      Text("Settings")
      Text(text = nativeStringResource("Connected"))
      ClawPrimaryButton(text = "Continue", onClick = {})
      ClawStatusPill(text = "Working")
      SettingsMetric("Gateway", gatewayName)
      ConnectionState(connected = false, statusText = "Connecting to $host")
      ConnectionState(connected = true, statusText = nativeString("Connected"))
      Text(text = fileName ?: "Attachment")
      Modifier.clickable(onClickLabel = "Open detail", onClick = {})
      Text(nativeString("First sentence. ") + "Second sentence.")
      val dynamic = Text(text = gateway.name)

      fun statusText(state: State): String =
        when (state) {
          State.Ready -> "Ready"
          State.Waiting -> nativeString("Waiting")
        }
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
      expect.objectContaining({ source: "Connecting to $host" }),
      expect.objectContaining({ source: "Attachment" }),
      expect.objectContaining({ source: "Open detail" }),
      expect.objectContaining({ source: "Second sentence." }),
      expect.objectContaining({ source: "Ready" }),
    ]);
    expect(
      findUnlocalizedAndroidUiLiterals(
        source,
        "apps/android/app/src/main/java/ai/openclaw/app/ui/Example.kt",
      ).map((finding) => finding.source),
    ).not.toEqual(expect.arrayContaining(["Connected", "Waiting"]));
  });

  it("maps typed model fields across generic types and named argument omissions", () => {
    const source = `
      data class GenericState(
        val metadata: Map<String, String>,
        val statusText: String,
      )
      data class OptionalState(
        val statusText: String = "",
        val code: String,
      )

      GenericState(emptyMap(), "Generic ready")
      OptionalState(code = "Internal code")
    `;
    const findings = findUnlocalizedAndroidUiLiterals(
      source,
      "apps/android/app/src/main/java/ai/openclaw/app/ui/Example.kt",
    ).map((finding) => finding.source);

    expect(findings).toContain("Generic ready");
    expect(findings).not.toContain("Internal code");
  });

  it("requires exact String fields and scans multiline helper expressions", () => {
    const source = `
      data class StringResource(val key: String)
      data class ResourceState(val statusText: StringResource)

      ResourceState(statusText = StringResource("resource_key"))

      fun errorText(failed: Boolean): String =
        if (failed) {
          "Failure"
        } else {
          nativeString("Ready")
        }

      fun helperText(value: String?): String =
        value
          ?: "Fallback"
    `;
    const findings = findUnlocalizedAndroidUiLiterals(
      source,
      "apps/android/app/src/main/java/ai/openclaw/app/ui/Example.kt",
    ).map((finding) => finding.source);

    expect(findings).toEqual(expect.arrayContaining(["Failure", "Fallback"]));
    expect(findings).not.toEqual(expect.arrayContaining(["resource_key", "Ready"]));
  });

  it("ignores preview fixtures", () => {
    expect(
      findUnlocalizedAndroidUiLiterals(
        'Text("Preview copy")',
        "apps/android/app/src/main/java/ai/openclaw/app/ui/design/ClawComponents.kt",
      ),
    ).toEqual([]);
  });
});
