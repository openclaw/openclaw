import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { showConfirmChoiceDialog, showConfirmDialog } from "../../components/confirm-dialog.ts";
import { i18n } from "../../i18n/index.ts";
import { sourceConfigSnapshot } from "../../lib/config/config-snapshot.test-support.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  clickPluginAction,
  createClient,
  createContext,
  createGateway,
  createInspectResult,
  createPlugin,
  createPluginsRouteData,
  createPluginsRouteLocation,
  createResult,
  methodCalls,
  mountPage,
  resetPluginsPageTestState,
} from "./plugins-page.test-support.ts";

vi.mock("../../components/confirm-dialog.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../components/confirm-dialog.ts")>()),
  showConfirmDialog: vi.fn(),
  showConfirmChoiceDialog: vi.fn(),
}));
beforeEach(async () => {
  await i18n.setLocale("en");
  vi.mocked(showConfirmDialog).mockReset().mockResolvedValue(true);
  vi.mocked(showConfirmChoiceDialog).mockReset().mockResolvedValue(null);
});
afterEach(resetPluginsPageTestState);
const uninstallLabel = "Uninstall Audit Provider";
function removablePlugin() {
  return createPlugin({
    id: "audit-plugin",
    name: "Audit Provider",
    origin: "global",
    removable: true,
    featured: false,
  });
}
function scriptedClient(handlers: Record<string, (params: unknown) => unknown>) {
  return createClient(async (method, params) => {
    const handler = handlers[method];
    if (!handler) {
      throw new Error("Unexpected method " + method);
    }
    return handler(params);
  });
}
function removalResult(pluginId: string) {
  return { ok: true, pluginId, removed: ["install record"] };
}
async function mountInventory(
  client: ReturnType<typeof createClient>["client"],
  result: ReturnType<typeof createResult>,
  pathname: string,
) {
  const { gateway } = createGateway(client);
  const context = createContext(gateway);
  const { page } = await mountPage(
    context,
    createPluginsRouteData(gateway, result, createPluginsRouteLocation(pathname)),
  );
  return { page, context };
}

it("warns before removing the selected provider and keeps reselection explicit", async () => {
  const plugin = removablePlugin();
  const inspection = createInspectResult({ plugin });
  inspection.declared.providers = ["audit-provider"];
  const pendingInspection = deferred<ReturnType<typeof createInspectResult>>();
  const { client, request } = scriptedClient({
    "plugins.inspect": () => pendingInspection.promise,
    "plugins.uninstall": () => removalResult(plugin.id),
    "plugins.list": () => createResult([]),
  });
  const { page, context } = await mountInventory(
    client,
    createResult(plugin),
    "/settings/plugins/" + plugin.id,
  );
  const config = {
    agents: {
      defaults: { model: { primary: "audit-provider/audit-chat", fallbacks: ["other/backup"] } },
    },
  };
  context.runtimeConfig.state.configSnapshot = {
    ...sourceConfigSnapshot(config),
    config,
    sourceConfig: config,
  };
  context.runtimeConfig.state.configForm = { agents: { defaults: { model: "other/draft" } } };
  await clickPluginAction(page, uninstallLabel);
  expect(showConfirmChoiceDialog).not.toHaveBeenCalled();
  expect(showConfirmDialog).not.toHaveBeenCalled();
  pendingInspection.resolve(inspection);
  await waitForSolid(() => expect(showConfirmChoiceDialog).toHaveBeenCalledOnce());
  expect(showConfirmChoiceDialog).toHaveBeenLastCalledWith(
    expect.objectContaining({
      message: expect.stringContaining("audit-provider/audit-chat"),
      alternativeLabel: "Choose another model",
      confirmLabel: "Remove",
    }),
  );
  expect(methodCalls(request, "plugins.uninstall")).toHaveLength(0);
  expect(context.navigate).not.toHaveBeenCalled();
  expect(context.runtimeConfig.state.configSnapshot?.sourceConfig).toEqual(config);

  vi.mocked(showConfirmChoiceDialog).mockResolvedValueOnce("alternative");
  await clickPluginAction(page, uninstallLabel);
  await waitForSolid(() => expect(context.navigate).toHaveBeenCalledWith("model-providers"));
  expect(methodCalls(request, "plugins.uninstall")).toHaveLength(0);
  expect(context.runtimeConfig.state.configSnapshot?.sourceConfig).toEqual(config);

  vi.mocked(showConfirmChoiceDialog).mockResolvedValueOnce("confirm");
  await clickPluginAction(page, uninstallLabel);
  await waitForSolid(() => expect(methodCalls(request, "plugins.uninstall")).toHaveLength(1));
  expect(context.runtimeConfig.patch).not.toHaveBeenCalled();
  expect(context.runtimeConfig.state.configSnapshot?.sourceConfig).toEqual(config);
});

it.each(["inspection", "config"])(
  "warns when the removal model check lacks %s",
  async (missing) => {
    const plugin = removablePlugin();
    const inspection = createInspectResult({ plugin });
    inspection.declared.providers = ["audit-provider"];
    const { client, request } = scriptedClient({
      "plugins.inspect": () => {
        if (missing === "inspection") {
          throw new Error("Inspection unavailable");
        }
        return inspection;
      },
    });
    const { page } = await mountInventory(
      client,
      createResult(plugin),
      "/settings/plugins/" + plugin.id,
    );
    await clickPluginAction(page, uninstallLabel);
    await waitForSolid(() => expect(showConfirmChoiceDialog).toHaveBeenCalledOnce());
    expect(showConfirmChoiceDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(
          "Could not check whether your default model uses this plugin",
        ),
        alternativeLabel: "Choose another model",
      }),
    );
    expect(methodCalls(request, "plugins.uninstall")).toHaveLength(0);
  },
);
