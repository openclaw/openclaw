import { describe, expect, it } from "vitest";
import { collectNativeI18nEntries, NATIVE_I18N_LOCALES } from "../../scripts/native-app-i18n.ts";

describe("native app i18n inventory", () => {
  it("collects stable Android and Apple UI entries", async () => {
    const entries = await collectNativeI18nEntries();
    const surfaces = new Set(entries.map((entry) => entry.surface));

    expect(entries.length).toBeGreaterThan(100);
    expect(surfaces).toEqual(new Set(["android", "apple"]));
    expect(entries.every((entry) => entry.id.startsWith(`native.${entry.surface}.`))).toBe(true);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
    expect(
      entries.every(
        (entry) => !/(?:\/|\\)(?:Tests?|UITests?|test|Preview(?:s)?)(?:\/|\\)/u.test(entry.path),
      ),
    ).toBe(true);
    expect(
      entries.every(
        (entry) => !/(?:Tests?|UITests?|Previews?|Testing)\.(?:swift|kt|kts)$/u.test(entry.path),
      ),
    ).toBe(true);
    expect(
      entries
        .filter((entry) => entry.surface === "apple")
        .every((entry) =>
          /^(?:apps\/ios|apps\/macos\/Sources|apps\/shared\/OpenClawKit\/Sources)\//u.test(
            entry.path,
          ),
        ),
    ).toBe(true);
    expect(entries.some((entry) => entry.source === "QR Scanner Unavailable")).toBe(true);
    expect(entries.some((entry) => entry.source === "Request ID: \\(requestId)")).toBe(true);
    expect(entries.some((entry) => entry.source === "Open ${row.title}")).toBe(true);
    expect(entries.some((entry) => entry.source === "$deviceModel · $appVersion")).toBe(true);
    expect(entries.some((entry) => entry.source === "Approval command copied")).toBe(true);
    expect(entries.some((entry) => entry.source === "Save Profile")).toBe(true);
    expect(entries.some((entry) => entry.source === "Pairing required")).toBe(true);
    expect(entries.some((entry) => entry.source === "Mute")).toBe(true);
    expect(entries.some((entry) => entry.source === "Creating...")).toBe(true);
    expect(entries.some((entry) => entry.source === "Permission required")).toBe(true);
    expect(entries.some((entry) => entry.source === "Searching…")).toBe(true);
    expect(entries.some((entry) => entry.source === "Run now")).toBe(true);
    expect(entries.some((entry) => entry.source === "Loading chat")).toBe(true);
    expect(entries.some((entry) => entry.source === "DIARY")).toBe(true);
    expect(entries.some((entry) => entry.source === "ask OpenClaw $prompt")).toBe(true);
    expect(entries.some((entry) => entry.source === "OpenClaw is paused")).toBe(true);
    expect(entries.some((entry) => entry.source === "Last issue")).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.source ===
          "First-time TLS connection.\n\nVerify this SHA-256 fingerprint out-of-band before trusting:\n\\(prompt.fingerprintSha256)",
      ),
    ).toBe(true);
    expect(
      entries.some((entry) =>
        entry.source.startsWith(
          "Exec approvals can only be reviewed while OpenClaw is open and connected.",
        ),
      ),
    ).toBe(true);
    expect(entries.some((entry) => entry.source === "$(PRODUCT_BUNDLE_IDENTIFIER)")).toBe(false);
    expect(entries.some((entry) => entry.source === "ai.openclaw.screenRecord.writer")).toBe(false);
    expect(
      entries.some(
        (entry) =>
          entry.surface === "android" && entry.source === "INVALID_REQUEST: expected JSON object",
      ),
    ).toBe(false);
    expect(
      entries.some(
        (entry) =>
          entry.surface === "android" && ["off", "talk-orb", "pulse"].includes(entry.source),
      ),
    ).toBe(false);
    expect(entries.some((entry) => entry.source === "false")).toBe(false);
    expect(entries.some((entry) => entry.source === "ws")).toBe(false);
    expect(entries.some((entry) => entry.source === '{"includeSecrets":true}')).toBe(false);
    expect(entries.some((entry) => entry.source === "builtIn")).toBe(false);
    expect(entries.some((entry) => entry.source === "State:  \\(stateDir)")).toBe(true);
    expect(entries.some((entry) => entry.path.endsWith("Info.plist"))).toBe(true);
    expect(NATIVE_I18N_LOCALES).toHaveLength(21);
    expect(NATIVE_I18N_LOCALES).toContain("sv");
  });
});
