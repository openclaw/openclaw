import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { getSafeLocalStorage } from "../../local-storage.ts";
import {
  captureI18nStateForTesting,
  createI18nManagerForTesting,
} from "./translate.test-support.ts";
import { i18n } from "./translate.ts";

it.each([
  { name: "absent", lang: null, dir: null, preference: null },
  { name: "empty", lang: "", dir: "", preference: "" },
  { name: "explicit", lang: "ar", dir: "rtl", preference: "en" },
])("restores $name document locale and preference after a separate manager", async (state) => {
  const root = document.documentElement;
  const storage = expectDefined(getSafeLocalStorage(), "test locale storage");
  const restoreOuterLocale = captureI18nStateForTesting();
  const originalAttributes = (["lang", "dir"] as const).map(
    (name) => [name, root.getAttribute(name)] as const,
  );
  try {
    await i18n.setLocale("en");
    for (const name of ["lang", "dir"] as const) {
      const value = state[name];
      if (value === null) {
        root.removeAttribute(name);
      } else {
        root.setAttribute(name, value);
      }
    }
    if (state.preference === null) {
      storage.removeItem("openclaw.i18n.locale");
    } else {
      storage.setItem("openclaw.i18n.locale", state.preference);
    }
    const restore = captureI18nStateForTesting();
    const manager = createI18nManagerForTesting(async () => ({ common: { health: "Gesundheit" } }));
    await manager.setLocale("de");
    expect(i18n.getLocale()).toBe("en");
    expect(root.lang).toBe("de");
    expect(root.dir).toBe("ltr");
    expect(storage.getItem("openclaw.i18n.locale")).toBe("de");

    await restore();

    expect(root.getAttribute("lang")).toBe(state.lang);
    expect(root.getAttribute("dir")).toBe(state.dir);
    expect(i18n.getLocale()).toBe("en");
    expect(storage.getItem("openclaw.i18n.locale")).toBe(state.preference);
  } finally {
    await restoreOuterLocale();
    // Keep the regression fixture isolated even when testing the broken helper.
    for (const [name, value] of originalAttributes) {
      if (value === null) {
        root.removeAttribute(name);
      } else {
        root.setAttribute(name, value);
      }
    }
  }
});
