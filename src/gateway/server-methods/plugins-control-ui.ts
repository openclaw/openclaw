import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import {
  ErrorCodes,
  errorShape,
  validatePluginsControlUiListParams,
  validatePluginsControlUiReloadParams,
  validatePluginsControlUiReportParams,
  validatePluginsControlUiStatusParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  listControlUiPluginCatalog,
  listControlUiPluginActivations,
  reportControlUiPluginActivation,
  reloadControlUiPluginCatalog,
} from "../control-ui-plugin-assets.js";
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayHandler } from "./validation.js";

export const pluginsControlUiHandlers: GatewayRequestHandlers = {
  "plugins.controlUi.report": defineValidatedGatewayHandler(
    "plugins.controlUi.report",
    validatePluginsControlUiReportParams,
    ({ params, client, respond, context }) => {
      const live =
        client?.connId &&
        context.getClientConnIds?.((candidate) => candidate === client).has(client.connId);
      if (!live || client.connect.client.id !== GATEWAY_CLIENT_IDS.CONTROL_UI) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "Activation reports require a connected Control UI",
          ),
        );
        return;
      }
      const rejectedPluginIds = params.reports
        .filter((report) => !reportControlUiPluginActivation(client, report))
        .map((report) => report.pluginId);
      if (rejectedPluginIds.length) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "Activation report is for an inactive browser revision",
            { details: { rejectedPluginIds } },
          ),
        );
        return;
      }
      respond(true, { ok: true });
    },
  ),
  "plugins.controlUi.status": defineValidatedGatewayHandler(
    "plugins.controlUi.status",
    validatePluginsControlUiStatusParams,
    ({ params, respond, context }) => {
      const clients: Array<{
        connId: string;
        activations: ReturnType<typeof listControlUiPluginActivations>;
      }> = [];
      context.getClientConnIds?.((client) => {
        if (client.connId && client.connect.client.id === GATEWAY_CLIENT_IDS.CONTROL_UI) {
          clients.push({
            connId: client.connId,
            activations: listControlUiPluginActivations(client, params.pluginId),
          });
        }
        return false;
      });
      if (clients.length > 128) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "Too many connected Control UI clients"),
        );
        return;
      }
      respond(true, {
        clients: clients.toSorted((left, right) => left.connId.localeCompare(right.connId)),
      });
    },
  ),
  // In-flight catalogs may finish with their selected record; asset reads recheck authority.
  "plugins.controlUi.list": defineValidatedGatewayHandler(
    "plugins.controlUi.list",
    validatePluginsControlUiListParams,
    async ({ respond }) => {
      const catalog = await listControlUiPluginCatalog();
      respond(true, catalog);
    },
    () => errorShape(ErrorCodes.UNAVAILABLE, "Control UI plugin catalog is unavailable"),
  ),
  "plugins.controlUi.reload": defineValidatedGatewayHandler(
    "plugins.controlUi.reload",
    validatePluginsControlUiReloadParams,
    async ({ params, respond, context }) => {
      const catalog = await reloadControlUiPluginCatalog(params.pluginId);
      context.broadcast("plugins.controlUi.changed", { revision: catalog.revision });
      respond(true, catalog);
    },
    () =>
      errorShape(
        ErrorCodes.UNAVAILABLE,
        "Control UI reload failed. Confirm the plugin is active, build its browser assets, and retry.",
      ),
  ),
};
