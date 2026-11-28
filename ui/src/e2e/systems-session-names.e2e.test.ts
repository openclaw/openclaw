import { expect, it } from "vitest";
import { controlUiSessionPath, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createActiveSessionPlacement } from "../test-helpers/session-placement.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Systems session names mocked Gateway E2E",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("labels worker attachments after the scoped roster arrives without more requests", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, locale: "en-US" },
      async ({ page }) => {
        const size = 250;
        const key = "agent:main:dashboard:release-notes";
        const workerId = "worker-one";
        const sessionId = "c9538a8c-f2b9-4fa1-9af5-86251b1d922d";
        const missingId = "a319f5eb-44f1-4692-8b7c-06f7e9b3cea2";
        const worker = {
          id: workerId,
          type: "worker",
          label: "Cloud worker",
          status: "available",
          worker: {
            profileId: "cloud",
            providerId: "crabbox",
            state: "attached",
            attachedSessionIds: [sessionId, missingId],
          },
        };
        const gateway = await installMockGateway(page, {
          awaitInitialRoster: false,
          methodDelays: { "sessions.list": "forever", "sessions.subscribe": "forever" },
          sessions: [
            createControlUiSessionRow(key, key, size + 3, {
              sessionId,
              placement: createActiveSessionPlacement({ environmentId: workerId }),
              label: undefined,
              derivedTitle: "Release notes review",
            }),
            createControlUiSessionRow("agent:main:other-worker", "Not this worker", size + 2, {
              sessionId: missingId,
              placement: createActiveSessionPlacement({ environmentId: "worker-other" }),
            }),
            ...Array.from({ length: size }, (_, i) =>
              createControlUiSessionRow(`agent:main:other-${i}`, `Other session ${i}`, size - i),
            ),
          ],
          featureMethods: ["environments.list", "node.list"],
          methodResponses: {
            "environments.list": {
              environments: [
                { id: "gateway", type: "local", label: "Gateway machine", status: "available" },
                worker,
                ...Array.from({ length: size }, (_, i) => ({
                  id: `worker-extra-${i}`,
                  type: "worker",
                  status: "available",
                })),
              ],
            },
            "node.list": { nodes: [] },
            "backup.status": { targets: [], schedules: [], locations: [] },
          },
        });
        await page.goto(suite.server.baseUrl + "systems");
        const selectWorker = page
          .locator(".systems-sidebar")
          .getByRole("button", { name: /Cloud worker/ });
        await selectWorker.click();
        const detailsButton = page
          .locator(".systems-toolbar")
          .getByRole("button", { name: "Details" });
        const details = page.getByRole("complementary", { name: "Details" });
        const attachments = details.getByRole("listitem");
        const openDetails = () => detailsButton.click();
        const countRequests = async () => {
          const requests = await gateway.getRequests();
          return {
            inventory: requests.filter(({ method }) => method === "environments.list").length,
            roster: requests.filter(
              ({ method }) => method === "sessions.list" || method === "sessions.subscribe",
            ).length,
            lookups: requests.filter(({ method }) =>
              ["sessions.describe", "sessions.get", "sessions.resolve"].includes(method),
            ).length,
          };
        };
        const before = await countRequests();
        await openDetails();
        await details.getByText(sessionId, { exact: true }).waitFor();
        expect(await countRequests()).toEqual(before);

        await gateway.setMethodDelay("sessions.list", null);
        await gateway.setMethodDelay("sessions.subscribe", null);
        const link = details.locator(".systems-session-link");
        await link.waitFor();
        const named = await countRequests();
        const labels = await attachments.allTextContents();
        const related = await link.locator("strong").textContent();
        await details.getByRole("button", { name: "Close details" }).click();
        await openDetails();
        await link.waitFor();
        expect(await countRequests()).toEqual(named);
        expect(named.lookups).toBe(0);
        expect(await link.getAttribute("href")).toBe(controlUiSessionPath(key));
        expect({ labels, related }).toEqual({
          labels: ["Release notes review", missingId],
          related: "Release notes review",
        });
      },
    );
  });
});
