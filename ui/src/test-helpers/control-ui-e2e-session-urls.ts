// Control UI e2e session URLs and in-app session navigation.
import { buildControlUiSessionPath } from "@openclaw/session-url-contract";
import type { Page } from "playwright";
import type { ControlUiReadiness } from "../app/control-ui-readiness.ts";

export function controlUiSessionPath(
  sessionKey: string,
  basePath = "",
  namespace: "chat" | "dashboard" = "chat",
): string {
  const pathname = buildControlUiSessionPath({
    namespace,
    sessionKey,
    fallbackAgentId: sessionKey.split(":")[1] || "main",
    basePath,
    shortIdLength: 32,
  });
  return pathname ?? `${basePath}/chat`;
}

export function controlUiSessionUrl(
  baseUrl: string,
  sessionKey: string,
  namespace: "chat" | "dashboard" = "chat",
): string {
  const url = new URL(baseUrl);
  // Cold fixture navigation knows the exact key; it must not depend on a warm
  // short-reference cache or a separately mocked sessions.resolve response.
  url.pathname =
    buildControlUiSessionPath({
      namespace,
      sessionKey,
      basePath: url.pathname,
      fallbackAgentId: sessionKey.split(":")[1] || "main",
      exactKey: true,
    }) ?? controlUiSessionPath(sessionKey, url.pathname, namespace);
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function navigateToControlUiSession(page: Page, sessionKey: string): Promise<void> {
  // The hook loads its readiness module on first read, so the first read can be undefined.
  await page.waitForFunction(() => window.openclawControlUi !== undefined);
  const expectedPathname = await page.evaluate((sessionPath) => {
    const app: ControlUiReadiness["hook"] | undefined = window.openclawControlUi;
    if (!app) {
      throw new Error("Control UI readiness hook is unavailable");
    }
    const pathname = `${app.snapshot().basePath}${sessionPath}`;
    const url = new URL(window.location.href);
    url.pathname = pathname;
    app.navigate("chat", { pathname });
    return url.pathname;
  }, controlUiSessionPath(sessionKey));
  await page.waitForURL((url) => url.pathname === expectedPathname);
  await page.waitForFunction(
    (targetSessionKey) =>
      window.openclawControlUi?.snapshot().routeReady === true &&
      window.openclawControlUi.snapshot().sessionKey === targetSessionKey,
    sessionKey,
  );
}

export function controlUiBundledGatewayUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.origin;
}

export function controlUiBundledSettingsStorageKey(baseUrl: string): string {
  return `openclaw.control.settings.v1:${controlUiBundledGatewayUrl(baseUrl)}`;
}
