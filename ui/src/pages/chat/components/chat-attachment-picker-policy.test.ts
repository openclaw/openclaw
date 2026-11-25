/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { attachmentBrowser } from "../../../e2e/chat-attachment-menu.test-support.ts";
import {
  useNativeAttachmentCapture,
  useNativeAttachmentSourceMenu,
} from "./chat-attachment-picker-policy.ts";

const hostFlags = ["__OPENCLAW_NATIVE_EMBED__", "__OPENCLAW_NATIVE_WEB_CHROME__"] as const;
const originalHostFlags = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
  for (const flag of hostFlags) {
    originalHostFlags.set(flag, Object.getOwnPropertyDescriptor(window, flag));
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const flag of hostFlags) {
    const original = originalHostFlags.get(flag);
    if (original) {
      Object.defineProperty(window, flag, original);
    } else {
      Reflect.deleteProperty(window, flag);
    }
  }
});

function installIdentity(name: string, touch?: number) {
  const fixture = attachmentBrowser(name);
  vi.stubGlobal("navigator", {
    userAgent: fixture.userAgent,
    platform: fixture.platform,
    maxTouchPoints: touch ?? fixture.touch,
  });
  Object.defineProperty(window, "__OPENCLAW_NATIVE_EMBED__", {
    configurable: true,
    value: fixture.embed ? { platform: fixture.embed, formFactor: "phone" } : undefined,
  });
  Object.defineProperty(window, "__OPENCLAW_NATIVE_WEB_CHROME__", {
    configurable: true,
    value: fixture.webChrome ?? false,
  });
}

it.each(
  (
    [
      ["iPhone Safari", true, false],
      ["iPad desktop Safari", true, false],
      ["Android Chrome", false, true],
      ["Android Edge", false, true],
      ["Android Firefox", false, true],
      ["Android Samsung", false, true],
      ["Android WebView", false, false],
      ["Android unknown app", false, false],
      ["Android web chrome", false, false],
      ["macOS Safari", false, false],
      ["unknown", false, false],
      ["iOS unknown engine", false, false],
      ["iOS in-app", false, false],
      ["iOS Chrome", false, false],
      ["iOS native", false, false],
      ["Android native", false, false],
      ["iOS web chrome", false, false],
    ] as const
  ).flatMap(([name, sourceMenu, nativeCapture]) =>
    (
      [
        [390, 844],
        [1024, 768],
        [820, 1180],
        [932, 430],
      ] as const
    ).map(([width, height]) => ({ name, sourceMenu, nativeCapture, width, height })),
  ),
)("keeps $name picker capabilities at $width x $height", (fixture) => {
  installIdentity(fixture.name);
  vi.stubGlobal("innerWidth", fixture.width);
  vi.stubGlobal("innerHeight", fixture.height);

  expect(useNativeAttachmentSourceMenu()).toBe(fixture.sourceMenu);
  expect(useNativeAttachmentCapture()).toBe(fixture.nativeCapture);
});

it.each([
  { touch: 1, sourceMenu: false },
  { touch: 2, sourceMenu: true },
])("classifies desktop Safari with $touch touch points", ({ touch, sourceMenu }) => {
  installIdentity("iPad desktop Safari", touch);
  vi.stubGlobal("innerWidth", 1024);
  vi.stubGlobal("innerHeight", 768);

  expect(useNativeAttachmentSourceMenu()).toBe(sourceMenu);
  expect(useNativeAttachmentCapture()).toBe(false);
});
