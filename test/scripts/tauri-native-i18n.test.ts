import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
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
  serializeTauriShellCatalogScript,
  type TauriShellCatalog,
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

  it("projects the native catalog only into packaged top-level pages", () => {
    const catalog: TauriShellCatalog = {
      version: 1,
      sourceInventorySha256: "0".repeat(64),
      messages: {
        "quickChat.messageAgent": {
          en: "Message {name}",
          ptPT: "Mensagem para {name}",
          args: ["name"],
        },
      },
    };
    const script = serializeTauriShellCatalogScript(catalog);
    const load = (href: string, topFrame = true) => {
      const window: { top?: unknown; __OPENCLAW_TAURI_CATALOG__?: TauriShellCatalog } = {};
      window.top = topFrame ? window : {};
      runInNewContext(script, { window, location: { href }, URL });
      return window;
    };

    const packaged = load("tauri://localhost/quickchat.html");
    expect(packaged["__OPENCLAW_TAURI_CATALOG__"]?.messages["quickChat.messageAgent"]?.ptPT).toBe(
      "Mensagem para {name}",
    );
    expect(
      Object.getOwnPropertyDescriptor(packaged, "__OPENCLAW_TAURI_CATALOG__")?.configurable,
    ).toBe(false);
    for (const [href, topFrame] of [
      ["tauri://localhost:12345/quickchat.html", true],
      ["https://tauri.localhost:12345/quickchat.html", true],
      ["tauri://localhost/quickchat.html", false],
      ["https://example.com/quickchat.html", true],
    ] as const) {
      expect(load(href, topFrame)["__OPENCLAW_TAURI_CATALOG__"]).toBeUndefined();
    }
  });

  it("uses current English when a packaged shell translation has stale source or arguments", async () => {
    const source = readFileSync(
      new URL("../../apps/linux/ui/tauri-i18n.js", import.meta.url),
      "utf8",
    );
    const document = {
      documentElement: { lang: "" },
      querySelectorAll: () => [],
    };
    const window: Record<string, unknown> = {
      __OPENCLAW_TAURI_CATALOG__: {
        version: 1,
        sourceInventorySha256: "0".repeat(64),
        messages: {
          "quickChat.messageAgent": {
            en: "Message {name}",
            ptPT: "Mensagem para {name}",
            args: ["oldName"],
          },
          "setup.connecting": {
            en: "Connecting to the old service",
            ptPT: "A ligar ao serviço antigo",
            args: [],
          },
        },
      },
      __OPENCLAW_TAURI_LOCALE__: "pt-PT",
    };
    window.top = window;
    runInNewContext(source, {
      window,
      document,
      location: { href: "tauri://localhost/index.html" },
      URL,
    });

    const ready = window["__OPENCLAW_TAURI_I18N_READY__"] as Promise<{
      locale: string;
      text: (key: string, args: Record<string, string>, fallback: string) => string;
    }>;
    expect(typeof ready.then).toBe("function");
    const api = await ready;
    expect(api.locale).toBe("pt-PT");
    expect(api.text("quickChat.messageAgent", { name: "Ada" }, "Message {name}")).toBe(
      "Message Ada",
    );
    expect(api.text("setup.connecting", {}, "Connecting to OpenClaw")).toBe(
      "Connecting to OpenClaw",
    );
  });
});
