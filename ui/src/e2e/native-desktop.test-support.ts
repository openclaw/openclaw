import { readFileSync } from "node:fs";
import type { Page } from "playwright";

export async function serveCompanion(page: Page) {
  await page.route("**/companion/**", (route) => {
    const { pathname } = new URL(route.request().url());
    const file = pathname.slice(pathname.indexOf("/companion/") + "/companion/".length);
    const sharedFont = [
      "instrument-sans-latin.woff2",
      "instrument-sans-latin-ext.woff2",
      "instrument-sans-OFL.txt",
    ].includes(file);
    return route.fulfill({
      contentType: file.endsWith(".js")
        ? "text/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : file.endsWith(".svg")
            ? "image/svg+xml"
            : file.endsWith(".woff2")
              ? "font/woff2"
              : file.endsWith(".txt")
                ? "text/plain"
                : "text/html",
      body: readFileSync(
        new URL(
          sharedFont ? `../../public/fonts/${file}` : `../../../apps/linux/ui/${file}`,
          import.meta.url,
        ),
      ),
    });
  });
}
