import { chromium, type Browser } from "playwright-core";

/** The full Chromium executable path managed by the host's Playwright runtime. */
export function getManagedChromiumExecutablePath(): string {
  return chromium.executablePath();
}

/** Launch a fresh headless Chromium process, independent of Browser profiles. */
export function launchHeadlessChromium(executablePath?: string): Promise<Browser> {
  return chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ["--disable-dev-shm-usage"],
  });
}
