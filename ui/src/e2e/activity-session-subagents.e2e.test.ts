import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { chatSessionListResponse, installMockGateway } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Activity excludes subagent sessions" });

suite.define(() => {
  it("requests the filtered feed on entry, search, and refresh while preserving normal conversations", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 1000 }, colorScheme: "light", locale: "en-US" },
      async ({ page }) => {
        const parent = {
          key: "agent:main:planning",
          kind: "direct" as const,
          label: "Subagent speed options and selection",
          updatedAt: Date.now(),
        };
        const child = {
          key: "agent:main:subagent:review",
          kind: "direct" as const,
          label: "Subagent: Verify release checks",
          spawnedBy: parent.key,
          updatedAt: Date.now(),
        };
        const gateway = await installMockGateway(page, {
          sessionKey: parent.key,
          methodResponses: {
            "sessions.list": {
              cases: [
                { match: { excludeSubagents: true }, response: chatSessionListResponse([parent]) },
                { response: chatSessionListResponse([child, parent]) },
              ],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}activity`);
        const rows = page.locator("[data-activity-session]");
        await page.locator(`[data-activity-session="${parent.key}"]`).waitFor();
        await page.screenshot({ path: path.join(suite.artifactDir, "activity-sessions.png") });
        await expect.poll(() => rows.count()).toBe(1);
        expect(await rows.textContent()).toContain(parent.label);

        const activityRequests = async () =>
          (await gateway.getRequests("sessions.list"))
            .map((request) => asNullableRecord(request.params))
            .filter((params) => params?.includePeople === true);

        await page.locator("openclaw-activity-page").getByRole("searchbox").fill("Subagent");
        await expect
          .poll(async () =>
            (await activityRequests()).some(
              (params) => params?.search === "Subagent" && params?.excludeSubagents === true,
            ),
          )
          .toBe(true);
        const beforeRefresh = (await activityRequests()).length;
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey: child.key,
          reason: "update",
        });
        await expect
          .poll(async () => (await activityRequests()).length)
          .toBeGreaterThan(beforeRefresh);
        await expect.poll(() => rows.count()).toBe(1);
        expect(await rows.textContent()).toContain(parent.label);
        expect(
          (await activityRequests()).every((params) => params?.excludeSubagents === true),
        ).toBe(true);
      },
    );
  });
});
