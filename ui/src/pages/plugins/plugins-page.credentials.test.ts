/* @vitest-environment jsdom */

import { afterEach, expect, it } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  createClient,
  createContext,
  createGateway,
  createInspectResult,
  createResult,
  resetPluginsPageTestState,
} from "./plugins-page.test-support.ts";
import { createPluginsPage } from "./plugins-page.ts";

afterEach(resetPluginsPageTestState);

it("reads the latest config error from a retained credential context after discard", async () => {
  const { client } = createClient(async () => createResult());
  const { gateway } = createGateway(client);
  const context = createContext(gateway);
  context.runtimeConfig.state.lastError = "Config read unavailable";
  context.runtimeConfig.discardFormValue = async () => {
    await Promise.resolve();
    context.runtimeConfig.state.lastError = "The last save could not be confirmed";
    return false;
  };
  let page!: ReturnType<typeof createPluginsPage>;
  const host = document.createElement("div");
  mountSolid(() => {
    page = createPluginsPage({
      context,
      element: () => host,
      routeData: () => undefined,
      surface: () => "settings",
    });
    return null;
  });
  const path = ["plugins", "entries", "workboard", "config", "apiKey"];
  page.setState({
    detail: {
      pluginId: "workboard",
      inspection: createInspectResult({
        credentials: [{ path, label: "API key", envVars: ["SERVICE_KEY"], status: "missing" }],
      }),
    },
  });
  const credential = page.settings.resolveCredential({
    path,
    label: "API key",
    property: "apiKey",
    schema: { type: "string" },
    value: undefined,
    hints: {},
    unsupported: new Set(),
    disabled: false,
    onPatch: page.settings.patch,
  })!;
  expect(credential.context.saveError).toBe("Config read unavailable");
  await expect(credential.context.onDiscard()).resolves.toBe(false);
  expect(credential.context.saveError).toBe("The last save could not be confirmed");
});
