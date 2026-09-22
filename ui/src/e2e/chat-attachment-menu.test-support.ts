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
  embed?: "ios" | "android";
  webChrome?: boolean;
};

// These are emulated identity hints, not native-browser/picker certification.
export const attachmentBrowserFixtures: AttachmentBrowserFixture[] = [
  {
    name: "iPhone Safari",
    userAgent: `${iphone} ${webkit} ${safari}`,
    platform: "iPhone",
    touch: 5,
    single: true,
  },
  {
    name: "iPad desktop Safari",
    userAgent: `${mac} ${webkit} Version/18.0 Safari/605.1.15`,
    platform: "MacIntel",
    touch: 5,
    single: true,
  },
  {
    name: "Android Chrome",
    userAgent: `${android} Chrome/153.0.0.0 Mobile Safari/537.36`,
    platform: "Linux armv8l",
    touch: 5,
  },
  {
    name: "Android Firefox",
    userAgent: "Mozilla/5.0 (Android 14; Mobile; rv:156.0) Gecko/156.0 Firefox/156.0",
    platform: "Linux armv8l",
    touch: 5,
  },
  {
    name: "Android Samsung",
    userAgent: `${android} SamsungBrowser/29.0 Chrome/136.0.0.0 Mobile Safari/537.36`,
    platform: "Linux armv8l",
    touch: 5,
  },
  {
    name: "macOS Safari",
    userAgent: `${mac} ${webkit} Version/18.0 Safari/605.1.15`,
    platform: "MacIntel",
    touch: 0,
  },
  {
    name: "Windows touch Chrome",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
    platform: "Win32",
    touch: 10,
  },
  { name: "unknown", userAgent: "UnknownBrowser/1.0", platform: "", touch: 0 },
  {
    name: "iOS unknown engine",
    userAgent: `${iphone} Gecko/156.0 Firefox/156.0`,
    platform: "iPhone",
    touch: 5,
  },
  {
    name: "iOS in-app",
    userAgent: `${iphone} ${webkit} Mobile/15E148`,
    platform: "iPhone",
    touch: 5,
  },
  {
    name: "iOS Chrome",
    userAgent: `${iphone} ${webkit} CriOS/153.0.0.0 Mobile/15E148 Safari/604.1`,
    platform: "iPhone",
    touch: 5,
  },
  {
    name: "iOS Firefox",
    userAgent: `${iphone} ${webkit} FxiOS/156.0 Mobile/15E148 Safari/605.1.15`,
    platform: "iPhone",
    touch: 5,
  },
  {
    name: "iOS unknown app",
    userAgent: `${iphone} ${webkit} ${safari} UnknownApp/1.0`,
    platform: "iPhone",
    touch: 5,
  },
  {
    name: "iOS native",
    userAgent: `${iphone} ${webkit} ${safari}`,
    platform: "iPhone",
    touch: 5,
    embed: "ios",
  },
  {
    name: "Android native",
    userAgent: `${android} Chrome/153.0.0.0 Mobile Safari/537.36`,
    platform: "Linux armv8l",
    touch: 5,
    embed: "android",
  },
  {
    name: "iOS web chrome",
    userAgent: `${iphone} ${webkit} ${safari}`,
    platform: "iPhone",
    touch: 5,
    webChrome: true,
  },
];

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
