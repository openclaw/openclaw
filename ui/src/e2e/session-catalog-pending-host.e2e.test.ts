import path from "node:path";
import { expect, it } from "vitest";
import type { SessionCatalog } from "../../../packages/gateway-protocol/src/index.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Pending paired-node catalog",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("keeps the paired-node row through pending refresh and applies its later publication", async () => {
    const artifactDir = createControlUiE2eArtifactDir("session-catalog-pending-host");
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const catalog: SessionCatalog = {
        id: "codex",
        label: "Codex",
        capabilities: { continueSession: false, archive: false },
        hosts: [
          {
            hostId: "node:devbox",
            label: "Dev Box",
            kind: "node",
            connected: true,
            sessions: [
              {
                threadId: "release-review",
                name: "Paired node release review",
                status: "stored",
                archived: false,
                canContinue: false,
                canArchive: false,
              },
            ],
          },
        ],
      };
      const gateway = await installMockGateway(page, {
        featureEvents: ["sessions.catalog.changed", "sessions.catalog.host"],
        featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list"],
        methodResponses: { "sessions.catalog.list": { catalogs: [catalog] } },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const sidebar = page.locator("openclaw-app-sidebar");
      const heldRow = sidebar.getByText("Paired node release review", { exact: true });
      await heldRow.waitFor();
      const pendingCatalog = {
        ...catalog,
        hosts: [{ ...catalog.hosts[0]!, sessions: [], pending: true }],
      };
      await gateway.setMethodResponse("sessions.catalog.list", { catalogs: [pendingCatalog] });
      const beforeRefresh = await gateway.deferNext("sessions.catalog.list");
      await gateway.emitGatewayEvent("sessions.catalog.changed", { agentId: "main" });
      const request = await gateway.waitForRequest("sessions.catalog.list", {
        after: beforeRefresh,
      });
      await gateway.resolveDeferred("sessions.catalog.list");
      // Capture before the assertion so the original row-clearing regression has visual evidence.
      await page.screenshot({ path: path.join(artifactDir, "pending-node.png") });
      expect(await heldRow.count()).toBe(1);
      expect(request.params).toMatchObject({
        allowPartialResults: true,
        progressId: expect.any(String),
      });

      await gateway.emitGatewayEvent("sessions.catalog.host", {
        progressId: (request.params as { progressId: string }).progressId,
        agentId: "main",
        catalog: {
          ...catalog,
          hosts: [
            {
              ...catalog.hosts[0]!,
              sessions: [
                { ...catalog.hosts[0]!.sessions[0]!, name: "Paired node review refreshed" },
              ],
            },
          ],
        },
      });
      await sidebar.getByText("Paired node review refreshed", { exact: true }).waitFor();
      expect(await heldRow.count()).toBe(0);
      await page.screenshot({ path: path.join(artifactDir, "refreshed-node.png") });
    });
  });
  it.each(["cross-host", "late-expanded"] as const)(
    "restores the current source window after %s progress",
    async (scenario) => {
      const artifacts = createControlUiE2eArtifactDir(`source-window-${scenario}`);
      await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
        const catalog: SessionCatalog = {
          id: "source-authorized",
          label: "Shared sessions",
          requiresFreshList: true,
          capabilities: { continueSession: false, archive: false },
          hosts: [
            {
              hostId: "node:a",
              label: "Source A",
              kind: "node",
              connected: true,
              nextCursor: "next",
              sessions: [
                {
                  threadId: "head",
                  name: "Authorized head",
                  status: "idle",
                  archived: false,
                  canContinue: false,
                  canArchive: false,
                },
              ],
            },
          ],
        };
        const hostA = catalog.hosts[0]!;
        const hostB = {
          ...hostA,
          hostId: "node:b",
          label: "Source B",
          pending: true,
          nextCursor: undefined,
          sessions: [],
        };
        const head = { catalogs: [catalog] };
        const deep = {
          catalogs: [
            {
              ...catalog,
              hosts: [
                {
                  ...hostA,
                  nextCursor: undefined,
                  sessions: [
                    { ...hostA.sessions[0]!, threadId: "deep", name: "Authorized deeper row" },
                  ],
                },
              ],
            },
          ],
        };
        const pending = {
          catalogs: [
            {
              ...catalog,
              hosts: [{ ...hostA, nextCursor: undefined, pending: true, sessions: [] }],
            },
          ],
        };
        const gateway = await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list"],
          featureEvents: ["sessions.catalog.changed", "sessions.catalog.host"],
          methodResponses: {
            "sessions.catalog.list":
              scenario === "cross-host"
                ? { catalogs: [{ ...catalog, hosts: [hostA, hostB] }] }
                : { sequence: [head, head, deep, pending, deep] },
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const sidebar = page.locator("openclaw-app-sidebar");
        await sidebar.getByText("Authorized head", { exact: true }).waitFor();
        const initial = (await gateway.getRequests("sessions.catalog.list"))[0]!;
        if (scenario === "cross-host") {
          await gateway.deferNext("sessions.catalog.list");
          await sidebar.locator('[data-session-catalog-load-more="source-authorized"]').click();
          await gateway.waitForRequest("sessions.catalog.list", { after: 1 });
          await expect
            .poll(() => sidebar.getByText("Authorized head", { exact: true }).count())
            .toBe(0);
          await gateway.emitGatewayEvent("sessions.catalog.host", {
            progressId: (initial.params as { progressId: string }).progressId,
            agentId: "main",
            catalog: {
              ...catalog,
              hosts: [
                {
                  ...hostB,
                  pending: false,
                  sessions: [
                    { ...hostA.sessions[0]!, threadId: "sibling", name: "Authorized sibling row" },
                  ],
                },
              ],
            },
          });
          await gateway.resolveDeferred("sessions.catalog.list", {
            catalogs: [
              {
                ...catalog,
                hosts: [
                  {
                    ...hostA,
                    nextCursor: undefined,
                    sessions: [{ ...hostA.sessions[0]!, name: "Fresh source window" }],
                  },
                ],
              },
            ],
          });
          await sidebar.getByText("Fresh source window", { exact: true }).waitFor();
          await page.screenshot({ path: path.join(artifacts, "settled-window.png") });
          expect(await sidebar.getByText("Authorized sibling row", { exact: true }).count()).toBe(
            1,
          );
          expect(await sidebar.getByText("Fresh source window", { exact: true }).count()).toBe(1);
        } else {
          await sidebar.locator('[data-session-catalog-load-more="source-authorized"]').click();
          await sidebar.getByText("Authorized deeper row", { exact: true }).waitFor();
          await page.screenshot({ path: path.join(artifacts, "expanded-window.png") });
          const beforeRefresh = await gateway.deferNext("sessions.catalog.list");
          await gateway.emitGatewayEvent("sessions.catalog.changed", { agentId: "main" });
          await gateway.waitForRequest("sessions.catalog.list", { after: beforeRefresh });
          await gateway.resolveDeferred("sessions.catalog.list");
          await expect
            .poll(() => sidebar.getByText("Authorized deeper row", { exact: true }).count())
            .toBe(0);
          expect(await sidebar.getByText("Authorized deeper row", { exact: true }).count()).toBe(0);
          const refresh = (await gateway.getRequests("sessions.catalog.list")).at(-1)!;
          await gateway.emitGatewayEvent("sessions.catalog.host", {
            progressId: (refresh.params as { progressId: string }).progressId,
            agentId: "main",
            catalog,
          });
          await page.screenshot({ path: path.join(artifacts, "late-publication.png") });
          await expect
            .poll(() => sidebar.getByText("Authorized deeper row", { exact: true }).count())
            .toBe(1);
          await page.screenshot({ path: path.join(artifacts, "restored-window.png") });
          expect(await sidebar.getByText("Authorized head", { exact: true }).count()).toBe(1);
          const requests = await gateway.getRequests("sessions.catalog.list");
          expect(requests).toHaveLength(5);
          expect(requests[4]!.params).toMatchObject({
            hostIds: ["node:a"],
            cursors: { "node:a": "next" },
          });
        }
      });
    },
  );
  it.each(["pending", "failed"] as const)(
    "withdraws source-authorized rows during a %s refresh",
    async (outcome) => {
      const artifactDir = createControlUiE2eArtifactDir(`source-authority-${outcome}`);
      await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
        const catalog = {
          id: "source-authorized",
          label: "Shared sessions",
          requiresFreshList: true,
          capabilities: { continueSession: false, archive: false },
          hosts: [
            {
              hostId: "node:source",
              label: "Source",
              kind: "node",
              connected: true,
              sessions: [
                {
                  threadId: "revoked",
                  name: "Previously authorized session",
                  status: "idle",
                  archived: false,
                  canContinue: false,
                  canArchive: false,
                },
              ],
            },
          ],
        };
        const gateway = await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list"],
          featureEvents: ["sessions.catalog.changed", "sessions.catalog.host"],
          methodResponses: { "sessions.catalog.list": { catalogs: [catalog] } },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const sidebar = page.locator("openclaw-app-sidebar");
        const row = sidebar.getByText("Previously authorized session", { exact: true });
        await row.waitFor();
        await page.screenshot({ path: path.join(artifactDir, "authorized.png") });
        await gateway.setMethodResponse("sessions.catalog.list", {
          catalogs: [
            {
              ...catalog,
              hosts: [
                {
                  ...catalog.hosts[0]!,
                  sessions: [],
                  ...(outcome === "pending"
                    ? { pending: true }
                    : {
                        error: { code: "NODE_INVOKE_FAILED", message: "Source unavailable" },
                      }),
                },
              ],
            },
          ],
        });
        const beforeRefresh = await gateway.deferNext("sessions.catalog.list");
        await gateway.emitGatewayEvent("sessions.catalog.changed", { agentId: "main" });
        await gateway.waitForRequest("sessions.catalog.list", { after: beforeRefresh });
        await gateway.resolveDeferred("sessions.catalog.list");
        await expect.poll(() => row.count()).toBe(0);
        await page.screenshot({ path: path.join(artifactDir, `${outcome}.png`) });
        expect(await row.count()).toBe(0);
        const request = (await gateway.getRequests("sessions.catalog.list")).at(-1)!;
        await gateway.emitGatewayEvent("sessions.catalog.host", {
          progressId: (request.params as { progressId: string }).progressId,
          agentId: "main",
          catalog: { ...catalog, hosts: [{ ...catalog.hosts[0]!, sessions: [] }] },
        });
        expect(await row.count()).toBe(0);
      });
    },
  );
});
