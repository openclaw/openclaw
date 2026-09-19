import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  reconnectMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Agent identity save reconnect" });

suite.define(() => {
  it.each(["agents.update", "config.get"])(
    "keeps the identity draft editable after reconnect interrupts %s",
    async (heldMethod) => {
      await suite.withPage(
        { locale: "en-US", viewport: { width: 1280, height: 900 } },
        async ({ page }) => {
          const artifacts = createControlUiE2eArtifactDir("agent-identity-reconnect");
          const config = { agents: { list: [{ id: "main" }] } };
          const gateway = await installMockGateway(page, {
            featureMethods: [...defaultControlUiFeatureMethods, "agents.update"],
            methodResponses: {
              "agents.update": { ok: true },
              "config.get": {
                config,
                sourceConfig: config,
                hash: "identity-fixture",
                issues: [],
                raw: JSON.stringify(config),
                valid: true,
              },
            },
          });
          await page.goto(`${suite.server.baseUrl}chat#token=test-token`);
          // Reopen a warm tab so its retained roster keeps this configured target selected offline.
          await expect
            .poll(() =>
              page.evaluate(() =>
                Object.keys(localStorage).some((key) =>
                  key.startsWith("openclaw.control.bootRecord.v1:"),
                ),
              ),
            )
            .toBe(true);
          await page.goto(`${suite.server.baseUrl}settings/agents/main/overview#token=test-token`);
          const name = page.locator(".agent-identity-editor__fields input").first();
          const save = page.locator(".agent-identity-editor__actions button");
          await name.fill("Lunar museum guide");
          const before = (await gateway.getRequests(heldMethod)).length;
          await gateway.deferNext(heldMethod);
          await save.click();
          await gateway.waitForRequest(heldMethod, { after: before });
          await expect.poll(() => save.textContent()).toContain("Saving");
          await reconnectMockGateway(page, gateway);
          await page.screenshot({
            path: path.join(artifacts, "reconnected.png"),
            animations: "disabled",
          });
          expect(await name.inputValue()).toBe("Lunar museum guide");
          await expect.poll(() => name.isEnabled()).toBe(true);
          await expect.poll(() => save.isEnabled()).toBe(true);
          await name.fill("Lunar museum curator");
          const updates = (await gateway.getRequests("agents.update")).length;
          await save.click();
          const request = await gateway.waitForRequest("agents.update", { after: updates });
          expect(request.params).toMatchObject({ agentId: "main", name: "Lunar museum curator" });
          await expect.poll(() => save.textContent()).toContain("Save");
          await expect.poll(() => name.isEnabled()).toBe(true);
        },
      );
    },
  );
});
