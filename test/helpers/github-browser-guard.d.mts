import type { BrowserContext, BrowserType } from "playwright";
export function installGitHubChromiumGuard(chromium: BrowserType): void;
export function withGitHubBrowserNegativeControls<T>(
  context: BrowserContext,
  urls: string[],
  action: () => Promise<T>,
): Promise<T>;
