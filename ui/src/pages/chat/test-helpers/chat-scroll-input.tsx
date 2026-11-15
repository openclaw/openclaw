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
  return () => Object.assign(document.createElement("template"), { innerHTML: markup }).content;
}
const controls = [
  ["input", staticControl('<input value="Text">')],
  ["textarea", staticControl("<textarea>Text</textarea>")],
  ["editable", staticControl('<div contenteditable="true"><span>Text</span></div>')],
  ["select", staticControl("<select><option>1<option selected>2<option>3</select>")],
] as const;
const boundaryKeys = ["Home", "End"];
const pageKeys = [...boundaryKeys, "PageUp", "PageDown"];
const mac = { platform: "MacIntel" };
export const nativeControlNavigationCases: NativeKeyCase[] = [];
function addKeys(
  name: string,
  content: () => JSX.Element,
  keys: readonly string[],
  owned: boolean | ((key: string) => boolean),
  fixture: NativeKeyFixture = {},
): void {
  for (const key of keys) {
    const controlOwned = typeof owned === "function" ? owned(key) : owned;
    nativeControlNavigationCases.push([`${name}${key}`, key, content, controlOwned, fixture]);
  }
}

const video = staticControl("<video controls></video>");
addKeys("video {} ", video, ["Home", "PageUp"], (key) => key === "Home");
for (const [name, content] of controls) {
  const ownsKey = (key: string) => name !== "input" || boundaryKeys.includes(key);
  addKeys(`Win32 ${name} `, content, pageKeys, ownsKey, { platform: "Win32" });
  if (name === "select") {
    addKeys("Win32 select Ctrl+", content, boundaryKeys, false, {
      platform: "Win32",
      ctrlKey: true,
    });
  }
  addKeys(`Mac ${name} Shift+`, content, boundaryKeys, true, { ...mac, shiftKey: true });
  if (name === "input" || name === "select") {
    addKeys(`Mac ${name} `, content, boundaryKeys, false, mac);
  } else {
    for (const key of pageKeys) {
      for (const inside of [true, false]) {
        const fixture = {
          ...mac,
          scrollTop: inside ? 240 : key === "Home" || key === "PageUp" ? 0 : 480,
        };
        const label = `Mac ${name} ${key} at ${inside ? "inner content" : "inner edge"}`;
        nativeControlNavigationCases.push([label, key, content, inside, fixture]);
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
