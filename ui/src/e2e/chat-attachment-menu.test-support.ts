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
function browser(
  name: string,
  userAgent: string,
  platform: string,
  options: Partial<AttachmentBrowserFixture> = {},
): AttachmentBrowserFixture {
  return { name, userAgent, platform, touch: 5, ...options };
}
const iosBrowser = (name: string, ua: string, options: Partial<AttachmentBrowserFixture> = {}) =>
  browser(name, ua, "iPhone", options);
const androidBrowser = (
  name: string,
  ua: string,
  options: Partial<AttachmentBrowserFixture> = {},
) => browser(name, ua, "Linux armv8l", options);

// Emulated identity hints, not native-browser/picker certification.
const attachmentBrowserFixtures: AttachmentBrowserFixture[] = [
  iosBrowser("iPhone Safari", iosSafari, { single: true }),
  browser("iPad desktop Safari", macSafari, "MacIntel", { single: true }),
  androidBrowser("Android Chrome", androidChrome, { nativeCapture: true }),
  androidBrowser("Android Edge", `${androidChrome} EdgA/153.0.0.0`, { nativeCapture: true }),
  androidBrowser(
    "Android Firefox",
    "Mozilla/5.0 (Android 14; Mobile; rv:156.0) Gecko/156.0 Firefox/156.0",
    { nativeCapture: true },
  ),
  androidBrowser(
    "Android Samsung",
    `${android} SamsungBrowser/29.0 Chrome/136.0.0.0 Mobile Safari/537.36`,
    { nativeCapture: true },
  ),
  androidBrowser(
    "Android WebView",
    `${android.replace("Pixel 8)", "Pixel 8; wv)")} Version/4.0 Chrome/153.0.0.0 Mobile Safari/537.36`,
  ),
  androidBrowser("Android unknown app", `${androidChrome} UnknownApp/1.0`),
  androidBrowser("Android web chrome", androidChrome, { webChrome: true }),
  browser("macOS Safari", macSafari, "MacIntel", { touch: 0 }),
  browser("unknown", "UnknownBrowser/1.0", "", { touch: 0 }),
  iosBrowser("iOS unknown engine", `${iphone} Gecko/156.0 Firefox/156.0`),
  iosBrowser("iOS in-app", `${iphone} ${webkit} Mobile/15E148`),
  iosBrowser("iOS Chrome", `${iphone} ${webkit} CriOS/153.0.0.0 Mobile/15E148 Safari/604.1`),
  iosBrowser("iOS native", iosSafari, { embed: "ios" }),
  androidBrowser("Android native", androidChrome, { embed: "android" }),
  iosBrowser("iOS web chrome", iosSafari, { webChrome: true }),
];

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
