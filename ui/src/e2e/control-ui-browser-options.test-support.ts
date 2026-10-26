import type { BrowserContextOptions } from "playwright";

export function createDarkDesktopControlUiContextOptions() {
  return {
    colorScheme: "dark",
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1440 },
  } as const satisfies BrowserContextOptions;
}

export function createLightDesktopControlUiContextOptions(): BrowserContextOptions {
  return {
    colorScheme: "light",
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 800, width: 1180 },
  };
}
