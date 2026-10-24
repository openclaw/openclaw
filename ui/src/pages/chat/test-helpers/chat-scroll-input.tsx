import type { JSX } from "@solidjs/web";
import { vi } from "vitest";

type NativeKeyFixture = {
  platform?: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  scrollTop?: number;
};

type NativeKeyCase = readonly [string, string, () => JSX.Element, boolean, NativeKeyFixture];

function staticControl(markup: string) {
  return () => {
    const template = document.createElement("template");
    template.innerHTML = markup;
    return template.content;
  };
}
const controls = [
  ["input", staticControl('<input value="Text">')],
  ["textarea", staticControl("<textarea>Text</textarea>")],
  ["editable", staticControl('<div contenteditable="true"><span>Text</span></div>')],
  ["select", staticControl("<select><option>1<option selected>2<option>3</select>")],
] as const;
const boundaryKeys = ["Home", "End"];
const pageKeys = [...boundaryKeys, "PageUp", "PageDown"];
export const nativeControlNavigationCases: NativeKeyCase[] = [];
function addKeys(
  name: string,
  content: () => JSX.Element,
  keys: readonly string[],
  owned: boolean | ((key: string) => boolean),
  fixture: NativeKeyFixture,
): void {
  for (const key of keys) {
    const controlOwned = typeof owned === "function" ? owned(key) : owned;
    nativeControlNavigationCases.push([`${name}${key}`, key, content, controlOwned, fixture]);
  }
}

for (const name of ["video", "audio"]) {
  const content = staticControl(`<${name} controls></${name}>`);
  const ownsKey = (key: string) => !key.startsWith("Page");
  for (const [keys, fixture] of [
    [[" ", "ArrowUp", "ArrowDown", ...pageKeys], {}],
    [boundaryKeys, { shiftKey: true }],
    [boundaryKeys, { ctrlKey: true }],
  ] as const) {
    addKeys(`${name} ${JSON.stringify(fixture)} `, content, keys, ownsKey, fixture);
  }
}
for (const [name, content] of controls) {
  const ownsKey = (key: string) => name !== "input" || boundaryKeys.includes(key);
  for (const platform of ["Win32", "Linux x86_64"]) {
    addKeys(`${platform} ${name} `, content, pageKeys, ownsKey, { platform });
    if (name === "select") {
      addKeys(`${platform} select Ctrl+`, content, boundaryKeys, false, {
        platform,
        ctrlKey: true,
      });
    }
  }
  addKeys(`Mac ${name} Shift+`, content, boundaryKeys, true, {
    platform: "MacIntel",
    shiftKey: true,
  });
  if (name === "input" || name === "select") {
    addKeys(`Mac ${name} `, content, boundaryKeys, false, { platform: "MacIntel" });
  } else {
    for (const key of pageKeys) {
      for (const inside of [true, false]) {
        nativeControlNavigationCases.push([
          `Mac ${name} ${key} at ${inside ? "inner content" : "inner edge"}`,
          key,
          content,
          inside,
          {
            platform: "MacIntel",
            scrollTop: inside ? 240 : key === "Home" || key === "PageUp" ? 0 : 480,
          },
        ]);
      }
    }
  }
}

export function configureNativeKeyTarget(control: Element, fixture: NativeKeyFixture = {}) {
  const platform = fixture.platform
    ? vi.spyOn(navigator, "platform", "get").mockReturnValue(fixture.platform)
    : undefined;
  if (fixture.scrollTop !== undefined) {
    control.setAttribute("style", "overflow-y: auto");
    Object.defineProperties(control, {
      clientHeight: { configurable: true, value: 160 },
      scrollHeight: { configurable: true, value: 640 },
      scrollTop: { configurable: true, writable: true, value: fixture.scrollTop },
    });
  }
  return () => platform?.mockRestore();
}
