import type { SystemAgentChatResult, WizardStep } from "@openclaw/gateway-protocol";
import { GATEWAY_SERVER_CAPS } from "@openclaw/gateway-protocol/frame-guards";
import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Custodian wizard validation" });
const options = {
  viewport: { width: 1280, height: 900 },
  colorScheme: "light" as const,
  reducedMotion: "reduce" as const,
  serviceWorkers: "block" as const,
};
const port: WizardStep = {
  id: "gateway-port",
  type: "text",
  executor: "client",
  message: "Gateway port",
  initialValue: "18789",
};
const reply = (text: string, step?: WizardStep): SystemAgentChatResult => ({
  sessionId: "wizard-validation",
  reply: text,
  action: "none",
  ...(step ? { wizardInputPending: true, step, sensitive: step.sensitive } : {}),
});
const install = (page: Parameters<typeof installMockGateway>[0], response: SystemAgentChatResult) =>
  installMockGateway(page, {
    featureMethods: [...defaultControlUiFeatureMethods, "openclaw.chat", "openclaw.chat.history"],
    featureCapabilities: [GATEWAY_SERVER_CAPS.SYSTEM_AGENT_WIZARD_CANCEL],
    methodResponses: { "openclaw.chat": response, "openclaw.chat.history": { turns: [] } },
  });

suite.define(() => {
  it("keeps a rejected text answer for correction and resets the next step", async () => {
    await suite.withPage(options, async ({ page }) => {
      const gateway = await install(page, reply("Choose a Gateway port.", port));
      await page.goto(`${suite.server.baseUrl}custodian`);
      const field = page.getByRole("textbox", { name: "Gateway port", exact: true });
      await field.fill("1878x");
      await gateway.setMethodResponse(
        "openclaw.chat",
        reply("Use a port number from 1 to 65535, for example 18789.", port),
      );
      await page
        .locator(".custodian__wizard-step")
        .getByRole("button", { name: "Submit", exact: true })
        .click();
      const error = page.getByText("Use a port number from 1 to 65535, for example 18789.", {
        exact: true,
      });
      await error.waitFor();
      expect(await field.inputValue()).toBe("1878x");
      expect((await gateway.getRequests("openclaw.chat")).at(-1)?.params).toMatchObject({
        wizardAnswer: { stepId: "gateway-port", value: "1878x" },
      });
      await field.fill("18788");
      await gateway.setMethodResponse(
        "openclaw.chat",
        reply("Choose a bind address.", {
          id: "bind-address",
          type: "text",
          executor: "client",
          message: "Bind address",
          initialValue: "127.0.0.1",
        }),
      );
      await page
        .locator(".custodian__wizard-step")
        .getByRole("button", { name: "Submit", exact: true })
        .click();
      const next = page.getByRole("textbox", { name: "Bind address", exact: true });
      await next.waitFor();
      expect(await next.inputValue()).toBe("127.0.0.1");
      expect((await gateway.getRequests("openclaw.chat")).at(-1)?.params).toMatchObject({
        wizardAnswer: { stepId: "gateway-port", value: "18788" },
      });
      await gateway.setMethodResponse(
        "openclaw.chat",
        reply("Setup cancelled. Nothing was changed beyond completed steps."),
      );
      await page.locator(".custodian__wizard-cancel").click();
      await page
        .getByText("Setup cancelled. Nothing was changed beyond completed steps.", { exact: true })
        .waitFor();
      expect(await page.locator(".custodian__wizard-step").count()).toBe(0);
      expect((await gateway.getRequests("openclaw.chat")).at(-1)?.params).toMatchObject({
        wizardCancel: { stepId: "bind-address" },
      });
    });
  });

  it("keeps sensitive answers cleared when validation returns the same step", async () => {
    await suite.withPage(options, async ({ page }) => {
      const step: WizardStep = {
        id: "credential",
        type: "text",
        executor: "client",
        message: "API credential",
        sensitive: true,
      };
      const gateway = await install(page, reply("Enter a credential.", step));
      await page.goto(`${suite.server.baseUrl}custodian`);
      const field = page.locator(".custodian__wizard-step input[type=password]");
      await field.fill("synthetic-private-value");
      await gateway.setMethodResponse(
        "openclaw.chat",
        reply("That credential was rejected. Enter another value.", step),
      );
      await page
        .locator(".custodian__wizard-step")
        .getByRole("button", { name: "Submit", exact: true })
        .click();
      await page
        .getByText("That credential was rejected. Enter another value.", { exact: true })
        .waitFor();
      expect(await field.inputValue()).toBe("");
      expect(await page.locator(".custodian__messages").textContent()).not.toContain(
        "synthetic-private-value",
      );
      expect((await gateway.getRequests("openclaw.chat")).at(-1)?.params).toMatchObject({
        wizardAnswer: { stepId: "credential", value: "synthetic-private-value" },
      });
    });
  });
});
