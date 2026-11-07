import { defineSolidPage } from "../../app-route-types.tsx";

export const page = defineSolidPage("secrets", () => {
  // Start the code font alongside the page without delaying fallback rendering.
  void document.fonts.load('14px "JetBrains Mono"').catch(() => {});
  return import("./secrets-page.tsx").then((module) => module.SecretsPage);
});
