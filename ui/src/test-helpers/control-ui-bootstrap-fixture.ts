import type { Page } from "playwright";
import {
  CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE,
  type ControlUiBootstrapConfig,
} from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { escapeHtml } from "../../../src/shared/html-escape.js";

type BootstrapFixtureScenario = Pick<
  ControlUiBootstrapConfig,
  | "basePath"
  | "assistantName"
  | "assistantAgentId"
  | "serverVersion"
  | "serverBuildId"
  | "devGitBranch"
  | "automaticallyFetchFavicons"
  | "communityInvite"
  | "terminalEnabled"
  | "cliAgentsEnabled"
  | "pluginAssetsRequireAuth"
> & {
  bootstrapPreferences?: ControlUiBootstrapConfig["preferences"];
  methodResponses: Record<string, unknown>;
};

export function buildControlUiMockBootstrapConfig(
  normalizedScenario: BootstrapFixtureScenario,
): ControlUiBootstrapConfig {
  const nativeCatalog = normalizedScenario.methodResponses["plugins.controlUi.list"] as
    | { plugins?: { pluginId: string }[] }
    | undefined;
  return {
    preferences: normalizedScenario.bootstrapPreferences,
    pluginAssetsRequireAuth: normalizedScenario.pluginAssetsRequireAuth,
    pluginFrameGrants: (normalizedScenario.pluginAssetsRequireAuth
      ? (nativeCatalog?.plugins ?? [])
      : []
    ).map(({ pluginId }) => ({
      pluginId,
      path: `/__openclaw__/plugins/control-ui/${encodeURIComponent(pluginId)}/`,
      match: "prefix",
    })),
    allowExternalEmbedUrls: false,
    automaticallyFetchFavicons: normalizedScenario.automaticallyFetchFavicons,
    communityInvite: normalizedScenario.communityInvite,
    assistantAgentId: normalizedScenario.assistantAgentId,
    assistantAvatar: "",
    assistantName: normalizedScenario.assistantName,
    basePath: normalizedScenario.basePath,
    devGitBranch: normalizedScenario.devGitBranch || undefined,
    embedSandbox: "scripts",
    serverVersion: normalizedScenario.serverVersion,
    serverBuildId: normalizedScenario.serverBuildId,
    terminalEnabled: normalizedScenario.terminalEnabled,
    cliAgentsEnabled: normalizedScenario.cliAgentsEnabled,
  };
}

/** Serve the same authenticated document seed as the Gateway, before app code starts. */
export async function installControlUiMockBootstrapDocument(
  page: Page,
  bootstrap: ControlUiBootstrapConfig,
) {
  const basePath = bootstrap.basePath.replace(/\/$/u, "");
  await page.route(
    (url) =>
      ["chat", "dashboard", "new"].some(
        (route) =>
          url.pathname === `${basePath}/${route}` ||
          url.pathname.startsWith(`${basePath}/${route}/`),
      ),
    async (route) => {
      if (!route.request().isNavigationRequest()) {
        return route.fallback();
      }
      const response = await route.fetch();
      await route.fulfill({
        response,
        body: (await response.text()).replace(
          "<html",
          `<html ${CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE}="${escapeHtml(JSON.stringify(bootstrap))}"`,
        ),
      });
    },
  );
}
