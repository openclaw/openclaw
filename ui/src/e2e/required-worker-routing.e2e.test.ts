import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import { projectSessionModelCatalog } from "../../../src/gateway/server-methods/chat-metadata-session-projection.js";
import type { ModelCatalogEntry } from "../api/types.ts";
import {
  captureUiProof,
  createNewSessionPageE2eSuite,
  installMockGateway,
  controlUiSessionPath,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const config: OpenClawConfig = {
  agents: { defaults: { model: { primary: "openai/worker-model" } }, entries: { main: {} } },
  cloudWorkers: {
    requiredProfile: "dedicated",
    profiles: {
      dedicated: { provider: "device", settings: { device: "paired", inference: "worker" } },
    },
  },
};
const hostModels: ModelCatalogEntry[] = [
  {
    id: "worker-model",
    provider: "openai",
    name: "Worker model",
    available: false,
    unavailableReason: "missing-auth",
  },
];

suite.define(() => {
  it.each(["before", "main", "bookmark"])("cold required worker chat: %s", async (route) => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const sessionKey = route === "bookmark" ? "agent:main:saved-worker" : "agent:main:main";
      const models =
        route === "before"
          ? hostModels
          : projectSessionModelCatalog(
              { agentId: "main", sessionKey },
              hostModels,
              config,
              undefined,
            );
      const gateway = await installMockGateway(page, {
        sessionKey,
        agentModel: "openai/worker-model",
        models,
        historyMessages: [],
        operatorScopes: ["operator.read", "operator.write"],
        featureMethods: ["chat.metadata", "chat.startup", "chat.send", "sessions.describe"],
        deferredMethods: ["chat.startup"],
        methodResponses: {
          "sessions.list": {
            count: 1,
            ts: 1,
            path: "",
            defaults: { model: "worker-model", modelProvider: "openai", contextTokens: 32768 },
            sessions: [
              {
                key: sessionKey,
                kind: "direct",
                displayName: "Dedicated worker",
                updatedAt: 1,
                model: "worker-model",
                modelProvider: "openai",
              },
            ],
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
      await composer.waitFor();
      if (route === "before") {
        await composer.fill("Hello from the dedicated worker");
        await expect
          .poll(() => page.getByRole("button", { name: "Send message", exact: true }).isDisabled())
          .toBe(true);
        await captureUiProof(suite, page, "before-cold-required-worker.png");
        return;
      }
      await expect.poll(() => composer.isEnabled()).toBe(true);
      await composer.fill("Hello from the dedicated worker");
      await captureUiProof(suite, page, "after-cold-required-worker-" + route + ".png");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      const sent = await gateway.waitForRequest("chat.send");
      expect(sent.params).toMatchObject({
        sessionKey,
        message: "Hello from the dedicated worker",
        deliver: false,
      });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
    });
  });
});
