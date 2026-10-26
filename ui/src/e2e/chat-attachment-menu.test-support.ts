import type { Page } from "playwright";

const webkit = "AppleWebKit/605.1.15 (KHTML, like Gecko)";
const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)";
const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";
const safari = "Version/18.0 Mobile/15E148 Safari/604.1";
const android = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko)";

export type AttachmentBrowserFixture = {
  name: string;
  userAgent: string;
  platform: string;
  touch: number;
  single?: boolean;
  nativeCapture?: boolean;
  embed?: "ios" | "android";
  webChrome?: boolean;
};

const iosSafari = `${iphone} ${webkit} ${safari}`;
const androidChrome = `${android} Chrome/153.0.0.0 Mobile Safari/537.36`;
const macSafari = `${mac} ${webkit} Version/18.0 Safari/605.1.15`;
// Emulated identity hints, not native-browser/picker certification.
const attachmentBrowserFixtures = (
  [
    ["iPhone Safari", iosSafari, "iPhone", { single: true }],
    ["iPad desktop Safari", macSafari, "MacIntel", { single: true }],
    ["Android Chrome", androidChrome, "Linux armv8l", { nativeCapture: true }],
    ["Android Edge", `${androidChrome} EdgA/153.0.0.0`, "Linux armv8l", { nativeCapture: true }],
    [
      "Android Firefox",
      "Mozilla/5.0 (Android 14; Mobile; rv:156.0) Gecko/156.0 Firefox/156.0",
      "Linux armv8l",
      { nativeCapture: true },
    ],
    [
      "Android Samsung",
      `${android} SamsungBrowser/29.0 Chrome/136.0.0.0 Mobile Safari/537.36`,
      "Linux armv8l",
      { nativeCapture: true },
    ],
    [
      "Android WebView",
      `${android.replace("Pixel 8)", "Pixel 8; wv)")} Version/4.0 Chrome/153.0.0.0 Mobile Safari/537.36`,
      "Linux armv8l",
    ],
    ["Android unknown app", `${androidChrome} UnknownApp/1.0`, "Linux armv8l"],
    ["Android web chrome", androidChrome, "Linux armv8l", { webChrome: true }],
    ["macOS Safari", macSafari, "MacIntel", { touch: 0 }],
    ["unknown", "UnknownBrowser/1.0", "", { touch: 0 }],
    ["iOS unknown engine", `${iphone} Gecko/156.0 Firefox/156.0`, "iPhone"],
    ["iOS in-app", `${iphone} ${webkit} Mobile/15E148`, "iPhone"],
    ["iOS Chrome", `${iphone} ${webkit} CriOS/153.0.0.0 Mobile/15E148 Safari/604.1`, "iPhone"],
    ["iOS native", iosSafari, "iPhone", { embed: "ios" }],
    ["Android native", androidChrome, "Linux armv8l", { embed: "android" }],
    ["iOS web chrome", iosSafari, "iPhone", { webChrome: true }],
  ] satisfies Array<[string, string, string, Partial<AttachmentBrowserFixture>?]>
).map(([name, userAgent, platform, options]): AttachmentBrowserFixture =>
  Object.assign({ name, userAgent, platform, touch: 5 }, options),
);

export function attachmentImage(name: string) {
  return {
    name,
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  };
}

export function attachmentBrowser(name: string) {
  const fixture = attachmentBrowserFixtures.find((candidate) => candidate.name === name);
  if (!fixture) {
    throw new Error(`Missing attachment fixture: ${name}`);
  }
  return fixture;
}

export function attachmentOption(page: Page, kind: string) {
  return page.locator(`.agent-chat__attach-menu-option[data-value="${kind}"]`);
}

export async function installAttachmentBrowserIdentity(
  page: Page,
  fixture: AttachmentBrowserFixture,
) {
  await page.addInitScript(({ platform, touch, embed, webChrome }) => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: touch });
    if (embed) {
      Object.assign(window, {
        __OPENCLAW_NATIVE_EMBED__: { platform: embed, formFactor: "phone" },
      });
    }
    if (webChrome) {
      Object.assign(window, { __OPENCLAW_NATIVE_WEB_CHROME__: true });
    }
  }, fixture);
}
