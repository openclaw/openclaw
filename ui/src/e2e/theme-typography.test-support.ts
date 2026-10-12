import {
  controlUiBundledGatewayUrl,
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import type { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

export const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

export function themeConfigResponse(theme: string, mode: "dark" | "light") {
  const config = { ui: { prefs: { theme, themeMode: mode } } };
  const hash = `theme-typography-${theme}-${mode}`;
  return {
    appliedConfigHash: hash,
    config,
    configRevisionHash: hash,
    hash,
    issues: [],
    raw: JSON.stringify(config),
    valid: true,
  };
}

export function createThemedChatOpener(suite: ReturnType<typeof createControlUiE2eSuite>) {
  async function openThemedChat(
    theme: string,
    mode: "dark" | "light",
    scenario: Pick<
      ControlUiMockGatewayScenario,
      "awaitInitialRoster" | "basePath" | "featureMethods" | "historyMessages" | "methodResponses"
    > = {},
  ) {
    const context = await suite.newBrowserContext({
      colorScheme: mode,
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    await context.addInitScript(
      ({ gatewayUrl, initialMode, initialTheme }) => {
        if (sessionStorage.getItem("typography-seeded")) {
          return;
        }
        sessionStorage.setItem("typography-seeded", "1");
        localStorage.setItem(
          `openclaw.control.settings.v1:${gatewayUrl}`,
          JSON.stringify({ gatewayUrl, theme: initialTheme, themeMode: initialMode }),
        );
      },
      {
        gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl),
        initialMode: mode,
        initialTheme: theme,
      },
    );
    const page = await context.newPage();
    const themeRequests: string[] = [];
    page.on("response", (response) => {
      const { pathname } = new URL(response.url());
      if (pathname.includes("/fonts/") || pathname.includes("/themes/")) {
        themeRequests.push(`${pathname.split("/").pop()} ${response.status()}`);
      }
    });
    const gateway = await installMockGateway(page, {
      ...scenario,
      methodResponses: {
        ...scenario.methodResponses,
        "config.get": themeConfigResponse(theme, mode),
      },
    });
    return { themeRequests, gateway, page };
  }

  return openThemedChat;
}
