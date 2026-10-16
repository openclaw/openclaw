import path from "node:path";
import { expect, it } from "vitest";
import type { SessionCatalog } from "../../../packages/gateway-protocol/src/index.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Source window lifecycle",
  startServerBeforeBrowser: true,
});
function source(name: string, cursor?: string): SessionCatalog {
  return {
    id: "shared",
    label: "Shared sessions",
    requiresFreshList: true,
    capabilities: { continueSession: false, archive: false },
    hosts: [
      {
        hostId: "node:source",
        label: "Source",
        kind: "node",
        connected: true,
        nextCursor: cursor,
        sessions: name
          ? [
              {
                threadId: name,
                name,
                status: "idle",
                archived: false,
                canContinue: false,
                canArchive: false,
              },
            ]
          : [],
      },
    ],
  };
}
function ordinary(name: string, cursor?: string): SessionCatalog {
  const { requiresFreshList: _fresh, ...catalog } = source(name, cursor);
  return { ...catalog, id: "ordinary", label: "Ordinary catalog" };
}
const result = (...catalogs: SessionCatalog[]) => ({ catalogs });
suite.define(() => {
  it("replays a late expanded source while another catalog is discovering hidden pages", async () => {
    const artifacts = createControlUiE2eArtifactDir("source-discovery-interval");
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const head = source("Authorized head", "next");
      const deep = source("Authorized deeper row");
      const pending = source("");
      pending.hosts[0]!.pending = true;
      const hidden = ordinary("", "hidden-next");
      const found = ordinary("Ordinary discovered row");
      const gateway = await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list"],
        featureEvents: ["sessions.catalog.changed", "sessions.catalog.host"],
        methodResponses: {
          "sessions.catalog.list": {
            sequence: [
              result(head),
              result(head),
              result(deep),
              result(pending, hidden),
              result(deep),
            ],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const sidebar = page.locator("openclaw-app-sidebar");
      const deeper = sidebar.getByText("Authorized deeper row", { exact: true });
      await sidebar.getByText("Authorized head", { exact: true }).waitFor();
      await sidebar.locator('[data-session-catalog-load-more="shared"]').click();
      await deeper.waitFor();
      await page.screenshot({ path: path.join(artifacts, "expanded.png") });
      await gateway.deferNext("sessions.catalog.list", { catalogId: "ordinary" });
      await gateway.emitGatewayEvent("sessions.catalog.changed", { agentId: "main" });
      await gateway.waitForRequest("sessions.catalog.list", { after: 4 });
      expect(await deeper.count()).toBe(0);
      const refresh = (await gateway.getRequests("sessions.catalog.list"))[3]!;
      await gateway.emitGatewayEvent("sessions.catalog.host", {
        progressId: (refresh.params as { progressId: string }).progressId,
        agentId: "main",
        catalog: head,
      });
      await gateway.resolveDeferred("sessions.catalog.list", result(found));
      await deeper.waitFor();
      await sidebar.getByText("Ordinary discovered row", { exact: true }).waitFor();
      // The capture precedes the assertion so the missing expanded window is retained on red.
      await page.screenshot({ path: path.join(artifacts, "settled.png") });
      expect(await deeper.count()).toBe(1);
      expect(await sidebar.getByText("Ordinary discovered row", { exact: true }).count()).toBe(1);
      expect(await gateway.getRequests("sessions.catalog.list")).toHaveLength(6);
    });
  });
  it.each(["host", "deeper", "transport"] as const)(
    "retries a fresh source after a transient %s failure",
    async (mode) => {
      const artifacts = createControlUiE2eArtifactDir(`source-retry-${mode}`);
      await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
        const initial = source("Previously authorized row", "old-cursor");
        const peer = {
          ...source("Unaffected sibling").hosts[0]!,
          hostId: "node:peer",
          label: "Peer",
        };
        initial.hosts.push(peer);
        const head = source("Fresh authorized head", "fresh-cursor");
        const deep = source("Fresh authorized deeper row");
        const failed = source("");
        failed.hosts[0]!.error = { code: "UNAVAILABLE", message: "Source temporarily unavailable" };
        const transport = {
          __mockError: { code: "UNAVAILABLE", message: "Source temporarily unavailable" },
        };
        const failure =
          mode === "host"
            ? [result(failed)]
            : mode === "deeper"
              ? [result(head), transport]
              : [transport];
        const gateway = await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list"],
          featureEvents: ["sessions.catalog.changed", "sessions.catalog.host"],
          methodResponses: {
            "sessions.catalog.list": {
              sequence: [result(initial), ...failure, result(head), result(deep)],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const sidebar = page.locator("openclaw-app-sidebar");
        const button = sidebar.locator('[data-session-catalog-load-more="shared"]');
        await sidebar.getByText("Previously authorized row", { exact: true }).waitFor();
        await button.click();
        await expect.poll(() => button.getAttribute("aria-busy")).toBe("false");
        await page.screenshot({ path: path.join(artifacts, "failure.png") });
        expect(await sidebar.getByText("Previously authorized row", { exact: true }).count()).toBe(
          0,
        );
        expect(await sidebar.getByText("Fresh authorized head", { exact: true }).count()).toBe(0);
        expect(await sidebar.getByText("Unaffected sibling", { exact: true }).count()).toBe(1);
        expect(await button.count()).toBe(1);
        const count = (await gateway.getRequests("sessions.catalog.list")).length;
        await button.click();
        await sidebar.getByText("Fresh authorized deeper row", { exact: true }).waitFor();
        await page.screenshot({ path: path.join(artifacts, "retried.png") });
        const requests = await gateway.getRequests("sessions.catalog.list");
        expect(requests).toHaveLength(count + 2);
        expect(requests[count]!.params).not.toHaveProperty("cursors");
        expect(requests[count + 1]!.params).toMatchObject({
          cursors: { "node:source": "fresh-cursor" },
        });
        expect(await sidebar.getByText("Previously authorized row", { exact: true }).count()).toBe(
          0,
        );
      });
    },
  );
});
