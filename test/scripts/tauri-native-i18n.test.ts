import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assignNativeI18nIds,
  collectNativeI18nEntries,
  validateNativeLocaleArtifact,
  type NativeI18nEntry,
} from "../../scripts/native-app-i18n.ts";
import {
  assertTauriPlaceholderParity,
  mergeTauriLocaleTranslations,
  parseTauriEnglishDeclaration,
} from "../../scripts/tauri-app-i18n.ts";

describe("Tauri native i18n inventory", () => {
  it("collects declared shell copy with stable message keys", async () => {
    const entries = await collectNativeI18nEntries();
    const messages = new Map(
      entries
        .filter((entry) => entry.surface === "tauri")
        .flatMap((entry) => entry.sites.map((site) => [site.kind, entry.source] as const)),
    );

    expect(messages.get("setup.connecting")).toBe("Connecting to OpenClaw");
    expect(messages.get("setup.connectionIssue")).toBe("CONNECTION ISSUE");
    expect(messages.get("quickChat.messageAgent")).toBe("Message {name}");
    const repeated = await collectNativeI18nEntries();
    expect(entries.filter((entry) => entry.surface === "tauri").map((entry) => entry.id)).toEqual(
      repeated.filter((entry) => entry.surface === "tauri").map((entry) => entry.id),
    );
  });

  it("keeps Tauri identity semantic while invalidating a changed English source", () => {
    const candidate = (key: string, source: string) => ({
      source,
      surface: "tauri" as const,
      path: "apps/linux/i18n/en.json",
      kind: key,
      line: 1,
    });
    const id = (key: string, source: string) => {
      const [entry] = assignNativeI18nIds([candidate(key, source)]);
      assert.ok(entry);
      return entry.id;
    };

    expect(id("menu.open", "Open")).not.toBe(id("menu.open", "Open the dashboard"));
    expect(id("menu.open", "Open")).not.toBe(id("quickChat.open", "Open"));
  });

  it("enforces Tauri named-argument parity through the native locale validator", () => {
    const entry: NativeI18nEntry = {
      id: "native.tauri.fixture",
      source: "Message {name}",
      surface: "tauri",
      sites: [{ kind: "quickChat.messageAgent", path: "apps/linux/i18n/en.json" }],
    };
    const artifact = {
      version: 2 as const,
      locale: "pt-PT",
      glossaryHash: createHash("sha256").update("[]").digest("hex"),
      translations: { [entry.id]: "Mensagem {agent}" },
    };

    expect(() => validateNativeLocaleArtifact("pt-PT", [entry], artifact)).toThrow(
      "Tauri translation placeholders or line breaks differ",
    );
  });

  it("adds explicit English fallback slots without changing existing native translations", () => {
    const artifact = {
      version: 2 as const,
      locale: "fr",
      glossaryHash: "fixture",
      translations: { "native.android.existing": "Réglages", "native.apple.existing": "Ouvrir" },
    };
    const entry = {
      id: "native.tauri.fixture",
      source: "Open {name}",
      surface: "tauri" as const,
      sites: [{ path: "apps/linux/i18n/en.json", kind: "menu.open" }],
    };

    expect(mergeTauriLocaleTranslations("fr", artifact, [entry]).translations).toEqual({
      "native.android.existing": "Réglages",
      "native.apple.existing": "Ouvrir",
      "native.tauri.fixture": "Open {name}",
    });
    expect(() => mergeTauriLocaleTranslations("pt-PT", artifact, [entry])).toThrow(
      "missing reviewed Tauri PT-PT translation",
    );
  });

  it("validates declared named arguments and preserves repeated placeholder multiplicity", () => {
    const declaration = parseTauriEnglishDeclaration(
      JSON.stringify({
        version: 1,
        messages: {
          "quickChat.messageAgent": { source: "Message {name} again, {name}", args: ["name"] },
        },
      }),
    );
    expect(declaration.messages).toMatchObject({
      "quickChat.messageAgent": { args: ["name"] },
    });
    expect(() =>
      parseTauriEnglishDeclaration(
        JSON.stringify({
          version: 1,
          messages: { "quickChat.messageAgent": { source: "Message {name}", args: [] } },
        }),
      ),
    ).toThrow("argument declaration does not match");
    expect(() =>
      assertTauriPlaceholderParity("Message {name} again, {name}", "Mensagem {name}", "fixture"),
    ).toThrow("placeholders or line breaks differ");
    expect(() => assertTauriPlaceholderParity("Line one\nLine two", "Linha um", "fixture")).toThrow(
      "placeholders or line breaks differ",
    );
  });
});
