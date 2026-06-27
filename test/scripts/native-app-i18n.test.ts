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
        .every((entry) => entry.path.startsWith("apps/ios/")),
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
    expect(entries.some((entry) => entry.path.endsWith("Info.plist"))).toBe(true);
    expect(NATIVE_I18N_LOCALES).toHaveLength(20);
  });
});
