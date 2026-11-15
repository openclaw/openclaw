import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { agentRoster } from "./agent-roster.test-support.ts";
import {
  configSnapshot,
  pageRunner,
  settingsPageOptions,
} from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Agent Tools refresh mocked Gateway E2E",
  startServerBeforeBrowser: true,
});
const runPage = pageRunner(suite, settingsPageOptions);

suite.define(() => {
  it.each([false, true])(
    "retains populated=%s preview layout while revalidating an effective change",
    async (populated) => {
      await runPage(async ({ page }) => {
        const config = { agents: { entries: { main: { tools: { profile: "full" } } } } };
        const effective = {
          agentId: "main",
          profile: "full",
          notices: [{ id: "accepted-policy", severity: "info", message: "Accepted policy notice" }],
          groups: populated
            ? [
                {
                  id: "core",
                  label: "Built-in tools",
                  source: "core",
                  tools: [
                    {
                      id: "read",
                      label: "Audit Read",
                      description: "Read a file",
                      rawDescription: "Read a file",
                      source: "core",
                    },
                  ],
                },
              ]
            : [],
        };
        const gateway = await installMockGateway(page, {
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "config.get",
            "tools.catalog",
            "tools.effective",
          ],
          operatorScopes: ["operator.read"],
          heldMethods: ["tools.effective"],
          methodResponses: {
            "agents.list": agentRoster({ main: "Main agent" }, "main", "agent"),
            "config.get": {
              ...configSnapshot(config, "tools-refresh"),
              sourceConfig: config,
              runtimeConfig: config,
            },
            "tools.effective": effective,
          },
        });
        await page.goto(suite.server.baseUrl + "settings/agents/main/tools");
        const preview = page.locator("#agent-panel .settings-section", {
          has: page.locator(".settings-section__heading", { hasText: "Tool preview" }),
        });
        await gateway.waitForRequest("tools.effective");
        await preview.locator(".settings-loading-skeleton").waitFor();
        await gateway.resolveDeferred("tools.effective", effective);
        const empty = preview.getByText(
          "No tools in this preview. More may become available before a reply.",
          { exact: true },
        );
        if (populated) {
          await preview.locator(".agent-tools-runtime-chip").waitFor();
        } else {
          await empty.waitFor();
        }
        const before = (await gateway.getRequests("tools.effective")).length;
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey: "agent:main:other",
          agentId: "main",
          reason: "patch",
          session: { key: "agent:main:other", title: "Unrelated rename" },
        });
        expect(await gateway.getRequests("tools.effective")).toHaveLength(before);
        const retained = await (
          populated ? preview.locator(".agent-tools-runtime-chip") : empty
        ).elementHandle();
        expect(retained).not.toBeNull();
        if (populated) {
          await retained!.focus();
        }
        await gateway.deferNext("tools.effective");
        // A matching generic patch may change effective policy; it is not a cosmetic certificate.
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey: "agent:main:main",
          agentId: "main",
          reason: "patch",
          session: { key: "agent:main:main", toolOverrides: { webSearch: false } },
        });
        await gateway.waitForRequest("tools.effective", { after: before });
        await preview.getByRole("status").filter({ hasText: "Loading preview…" }).waitFor();
        expect(await preview.locator(".settings-loading-skeleton").count()).toBe(0);
        expect(await retained!.evaluate((el) => el.isConnected)).toBe(true);
        if (populated) {
          expect(await retained!.evaluate((el) => document.activeElement === el)).toBe(true);
        }
        expect(await preview.textContent()).not.toContain("Accepted policy notice");
        const frame = await takeControlUiScreenshotFrame(page, page.locator("body"), [preview], {
          animations: "disabled",
          elements: [preview],
        });
        await writeFile(
          path.join(suite.artifactDir, "tools-" + populated + "-pending.png"),
          frame.png,
        );
        await writeFile(
          path.join(suite.artifactDir, "tools-" + populated + "-pending-panel.png"),
          frame.elements[0]!.png,
        );
        // The accepted replacement, not the retained informational layout, owns final availability.
        await gateway.resolveDeferred("tools.effective", { ...effective, notices: [], groups: [] });
        await empty.waitFor();
        await preview
          .getByRole("status")
          .filter({ hasText: "Loading preview…" })
          .waitFor({ state: "hidden" });
        expect(await preview.locator(".agent-tools-runtime-chip").count()).toBe(0);
      });
    },
  );
});
