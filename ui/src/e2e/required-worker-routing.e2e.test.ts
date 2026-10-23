import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import { projectSessionModelCatalog } from "../../../src/gateway/server-methods/chat-metadata-session-projection.js";
import type { ModelCatalogEntry } from "../api/types.ts";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
  controlUiSessionPath,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const model = { id: "worker-model", provider: "openai", name: "Worker model" };
const selection = { model: model.id, modelProvider: model.provider };
const message = "Hello from the dedicated worker";
const dedicated = {
  provider: "device",
  settings: { device: "paired", inference: "worker" },
} as const;
const config: OpenClawConfig = {
  agents: { defaults: { model: { primary: "openai/worker-model" } }, entries: { main: {} } },
  cloudWorkers: { requiredProfile: "dedicated", profiles: { dedicated } },
};
const hostModels: ModelCatalogEntry[] = [
  { ...model, available: false, unavailableReason: "missing-auth" },
];

suite.define(() => {
  it.each(["before", "main", "bookmark"])("cold required worker chat: %s", async (route) => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const sessionKey = route === "bookmark" ? "agent:main:saved-worker" : "agent:main:main";
      const target = { agentId: "main", sessionKey };
      const models =
        route === "before"
          ? hostModels
          : projectSessionModelCatalog(target, hostModels, config, undefined);
      const gateway = await installMockGateway(page, {
        sessionKey,
        agentModel: "openai/worker-model",
        models,
        operatorScopes: ["operator.read", "operator.write"],
        featureMethods: ["chat.metadata", "chat.startup", "chat.send", "sessions.describe"],
        deferredMethods: ["chat.startup"],
        methodResponses: {
          "sessions.list": {
            count: 1,
            ts: 1,
            path: "",
            defaults: { ...selection, contextTokens: 32768 },
            sessions: [{ key: sessionKey, kind: "direct", updatedAt: 1, ...selection }],
          },
        },
      });
      await page.goto(
        suite.server.baseUrl +
          (route === "bookmark" ? controlUiSessionPath(sessionKey).slice(1) : "chat/main"),
      );
      await gateway.waitForRequest("chat.startup");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await gateway.resolveDeferred("chat.startup");
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      const send = page.getByRole("button", { name: "Send message", exact: true });
      await composer.waitFor();
      if (route === "before") {
        await composer.fill(message);
        await expect.poll(() => send.isDisabled()).toBe(true);
        return;
      }
      await expect.poll(() => composer.isEnabled()).toBe(true);
      await composer.fill(message);
      await send.click();
      const sent = await gateway.waitForRequest("chat.send");
      expect(sent.params).toMatchObject({ sessionKey, message, deliver: false });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
    });
  });
});
