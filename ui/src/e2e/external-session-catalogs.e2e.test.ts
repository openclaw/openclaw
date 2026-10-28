import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "OpenCode and Pi external session catalogs",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const SHARE_ROUTE = {
  kind: "thread-id-prefix",
  routeSegment: "beam",
  hostId: "gateway",
  identifierAlphabet: "lowercase-hex",
  fullLength: 32,
  minPrefixLength: 12,
  lookup: "catalog-list-search-by-thread-id-prefix",
  ambiguity: "multiple-results-or-next-cursor",
} as const;

const featureMethods = [
  "chat.metadata",
  "chat.startup",
  "sessions.catalog.list",
  "sessions.catalog.read",
];
const visiblePane = "openclaw-chat-pane.chat-pane-cache__pane--visible";
const exactText = (root: Page | Locator, text: string) => root.getByText(text, { exact: true });
type CatalogPane = HTMLElement & {
  active: boolean;
  presented: boolean;
  sessionKey: string;
  state: { assistantAgentId: string; selfUser: { id: string } | null; connected: boolean };
};
const waitForChat = (page: Page, agent: string, search = "") =>
  waitForControlUiRoute(page, { routeId: "chat", pathname: `/chat/${agent}`, search });
const paneStates = (locator: Locator) =>
  locator.evaluateAll((panes) =>
    panes.map((pane) => {
      const { active, presented, sessionKey, state } = pane as CatalogPane;
      return {
        active,
        presented,
        sessionKey,
        owner: state.assistantAgentId,
        selfId: state.selfUser?.id,
        connected: state.connected,
      };
    }),
  );
function makeCatalog(
  id: string,
  label: string,
  threadId: string,
  name: string,
  host: { hostId: string; label: string; kind: string; nodeId?: string },
  options: {
    canContinue?: boolean;
    status?: string;
    archived?: boolean;
    sourceHomeId?: string;
    shareRoute?: typeof SHARE_ROUTE;
  } = {},
) {
  const { canContinue = false, status = "stored", shareRoute, ...session } = options;
  return {
    id,
    label,
    capabilities: { continueSession: canContinue, archive: false },
    ...(shareRoute ? { shareRoute } : {}),
    hosts: [
      {
        ...host,
        connected: true,
        sessions: [{ threadId, name, status, canContinue, canArchive: false, ...session }],
      },
    ],
  };
}

suite.define(() => {
  it.each(["Riley"])(
    "keeps external transcript authors independent of viewer %s",
    async (viewer) => {
      await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
        const catalogIds = ["beam", "claude", "codex"];
        await page.route("**/api/users/uploader-profile/avatar*", (route) =>
          route.fulfill({
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#43786a"/><text x="20" y="28" text-anchor="middle" fill="white" font-size="24">T</text></svg>',
          }),
        );
        await installMockGateway(page, {
          presenceUsers: [
            {
              self: true,
              id: "viewer-profile",
              identity: { type: "profile", id: "viewer-profile" },
              name: viewer,
              avatarUrl: "/viewer-avatar.png",
            },
          ],
          featureMethods,
          methodResponses: {
            "sessions.catalog.list": {
              catalogs: catalogIds.map((id) =>
                makeCatalog(id, id, "shared", `${id} shared transcript`, {
                  hostId: "gateway",
                  label: "Shared transcripts",
                  kind: "gateway",
                }),
              ),
            },
            "sessions.catalog.read": {
              hostId: "gateway",
              threadId: "shared",
              items: [
                {
                  id: "known-question",
                  type: "userMessage",
                  text: "The uploader's question.",
                  sender: {
                    identity: { type: "profile", id: "uploader-profile" },
                    label: "Taylor",
                    avatarUrl: "/api/users/uploader-profile/avatar?v=2",
                  },
                },
                { id: "answer", type: "agentMessage", text: "The imported answer." },
                { id: "question", type: "userMessage", text: "The imported author's question." },
              ],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        for (const catalogId of catalogIds) {
          await exactText(page, `${catalogId} shared transcript`).click();
          // Every catalog has the same transcript; wait for the clicked pane before reading it.
          const pane = page.locator(visiblePane);
          const sessionKey = `agent:main:catalog:${catalogId}:gateway:shared`;
          await expect
            .poll(async () => (await paneStates(pane)).some((row) => row.sessionKey === sessionKey))
            .toBe(true);
          const users = pane.locator(".chat-group.user");
          const message = users.filter({ hasText: "The imported author's question." });
          await message.waitFor();
          expect(await message.locator(".chat-sender-name").textContent()).toBe("User");
          expect(
            await message
              .locator(`[aria-label="${viewer}"], img[alt="${viewer}"], img[src*="viewer-avatar"]`)
              .count(),
          ).toBe(0);
          expect(await message.locator('a[href*="activity"]').count()).toBe(0);
          const known = users.filter({ hasText: "The uploader's question." });
          expect(await known.locator(".chat-sender-name").textContent()).toBe("Taylor");
          await expect
            .poll(() =>
              known
                .locator('img.chat-avatar[alt="Taylor"]')
                .evaluateAll((images) =>
                  images.some((image) => (image as HTMLImageElement).naturalWidth > 0),
                ),
            )
            .toBe(true);
          expect(await known.locator('a[href*="uploader-profile"]').count()).toBeGreaterThan(0);
        }
      });
    },
  );

  it.each(["sidebar", "cold link"])(
    "preserves catalog pane ownership from %s through retention, split focus, reconnect and adoption",
    async (entrance) => {
      await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
        const source = {
          catalogId: "fixture-catalog",
          hostId: "node:DevBox",
          threadId: "Thread:A/B",
        };
        const search = `?${new URLSearchParams({ catalog: source.catalogId, host: source.hostId, thread: source.threadId })}`;
        const ownerSource = (agentId: string) => ({
          ...source,
          agentId,
          sourceHomeId: `${agentId}-home`,
        });
        const owners = ["main", "other"];
        const gateway = await installMockGateway(page, {
          agentModel: "openai/gpt-5.6-luna",
          featureMethods: [...featureMethods, "sessions.catalog.continue"],
          methodResponses: {
            "agents.list": {
              defaultId: "main",
              mainKey: "main",
              scope: "agent",
              agents: owners.map((id) => ({ id, name: id === "main" ? "Main" : "Other" })),
            },
            "agent.identity.get": {
              cases: owners.map((agentId) => ({
                match: { agentId },
                response: { agentId, name: agentId === "main" ? "Main" : "Other", avatar: "" },
              })),
            },
            "sessions.catalog.list": {
              cases: owners.map((agentId) => ({
                match: { agentId },
                response: {
                  catalogs: [
                    makeCatalog(
                      source.catalogId,
                      "Native fixture",
                      source.threadId,
                      `${agentId} native thread`,
                      { hostId: source.hostId, label: "Dev Box", kind: "node" },
                      { canContinue: true, sourceHomeId: `${agentId}-home` },
                    ),
                  ],
                },
              })),
            },
            "sessions.catalog.read": {
              cases: owners.map((agentId) => ({
                match: ownerSource(agentId),
                response: {
                  ...source,
                  items: [{ type: "agentMessage", text: `${agentId} native transcript` }],
                },
              })),
            },
            "sessions.catalog.continue": {
              cases: owners.map((agentId) => ({
                match: ownerSource(agentId),
                response: { sessionKey: `agent:${agentId}:adopted-native` },
              })),
            },
          },
        });
        const activePane = page.locator(
          "openclaw-chat-pane.chat-pane-cache__pane--active:not([inert])",
        );
        const composer = () => activePane.locator(".agent-chat__composer-combobox > textarea");
        const navigate = async (agentId: string, catalog = true) => {
          await evaluateControlUiContext(
            page,
            (context, { agentId: routeAgentId, search: routeSearch }) => {
              context.navigate("chat", {
                pathname: `/chat/${routeAgentId}`,
                search: routeSearch,
              });
            },
            { agentId, search: catalog ? search : "" },
          );
          await waitForChat(page, agentId, catalog ? search : "");
        };
        const assertOwner = async (agentId: string) => {
          await expect
            .poll(() =>
              evaluateControlUiContext(page, (context) => context.agentSelection.state.selectedId),
            )
            .toBe(agentId);
          await expect
            .poll(() => paneStates(activePane))
            .toMatchObject([{ active: true, presented: true, owner: agentId }]);
        };

        await page.goto(
          `${suite.server.baseUrl}chat/${entrance === "cold link" ? `other${search}` : "main"}`,
        );
        const sidebar = page.locator("openclaw-app-sidebar");
        if (entrance === "sidebar") {
          await sidebar.getByRole("button", { name: /Switch agent/ }).click();
          await sidebar
            .locator(".sidebar-agent-menu")
            .getByRole("menuitem", { name: "Other", exact: true })
            .click();
          await waitForChat(page, "other");
          await assertOwner("other");
          await exactText(sidebar, "other native thread").click();
        }
        await waitForChat(page, "other", search);
        expect((await gateway.waitForRequest("sessions.catalog.read")).params).toMatchObject(
          ownerSource("other"),
        );
        await exactText(activePane, "other native transcript").waitFor();
        await assertOwner("other");
        await expect
          .poll(() =>
            sidebar
              .locator('[data-session-section="catalog:fixture-catalog"] a[aria-current="page"]')
              .textContent(),
          )
          .toContain("other native thread");
        await composer().fill("other retained draft");

        // Same source, different route owner: no intervening ordinary session may hide a key collision.
        await navigate("main");
        await exactText(activePane, "main native transcript").waitFor();
        await assertOwner("main");
        expect(await composer().inputValue()).toBe("");
        await composer().fill("main retained draft");
        await navigate("other");
        await assertOwner("other");
        expect(await composer().inputValue()).toBe("other retained draft");
        const mainPane = page
          .locator("openclaw-chat-pane")
          .filter({ hasText: "main native transcript" });
        expect(await mainPane.count()).toBe(1);
        const readsBeforeReturn = (await gateway.getRequests("sessions.catalog.read")).length;
        await navigate("other", false);
        await exactText(sidebar, "other native thread").click();
        await waitForChat(page, "other", search);
        await assertOwner("other");
        expect(await composer().inputValue()).toBe("other retained draft");
        expect(await gateway.getRequests("sessions.catalog.read")).toHaveLength(readsBeforeReturn);

        await selectChatLayoutAction(activePane, "Open split view");
        await navigate("main");
        const visiblePanes = page.locator(
          "openclaw-chat-pane.chat-pane-cache__pane--visible:not([inert])",
        );
        const splitOwners = ["other", "main"];
        await expect.poll(() => visiblePanes.count()).toBe(2);
        await exactText(visiblePanes, "other native transcript").click();
        await waitForChat(page, "other", search);
        await assertOwner("other");
        await exactText(visiblePanes, "main native transcript").click();
        await waitForChat(page, "main", search);
        await assertOwner("main");

        // Ordinary Gateway publication and transport reconnect must retain each pane's owner.
        const instanceId = await evaluateControlUiContext(
          page,
          (context) => context.gateway.snapshot.client?.instanceId,
        );
        await gateway.emitGatewayEvent("presence", {
          presence: [{ instanceId, user: { id: "fixture-user", name: "Fixture User" } }],
        });
        await expect
          .poll(() => paneStates(visiblePanes))
          .toMatchObject(splitOwners.map((owner) => ({ selfId: "fixture-user", owner })));
        await assertOwner("main");
        await gateway.closeLatest();
        await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(1);
        await expect
          .poll(() => paneStates(visiblePanes))
          .toMatchObject(splitOwners.map((owner) => ({ connected: true, owner })));
        await exactText(visiblePanes, "other native transcript").click();
        await waitForChat(page, "other", search);
        await assertOwner("other");
        await composer().fill("/bt");
        await page.getByRole("option").filter({ hasText: "/btw" }).click();
        expect(await gateway.getRequests("sessions.catalog.continue")).toHaveLength(0);
        expect(await composer().inputValue()).toBe("/btw ");
        await composer().fill("Continue under Other");
        await activePane.getByRole("button", { name: "Send message", exact: true }).click();
        expect((await gateway.waitForRequest("sessions.catalog.continue")).params).toMatchObject(
          ownerSource("other"),
        );
        const sent = await gateway.waitForRequest("chat.send");
        expect(sent.params).toMatchObject({
          sessionKey: "agent:other:adopted-native",
          message: "Continue under Other",
        });
        await waitForChat(page, "other/adopted-native");
        await assertOwner("other");
        await gateway.emitChatFinal({
          runId: (sent.params as { idempotencyKey: string }).idempotencyKey,
          sessionKey: "agent:other:adopted-native",
          text: "Other continuation completed",
        });
        await exactText(activePane.locator("p"), "Other continuation completed").waitFor();
        const adoptedRow = sidebar.locator('[data-session-key="agent:other:adopted-native"]');
        await navigate("other", false);
        await adoptedRow.locator("a").click();
        await waitForChat(page, "other/adopted-native");
        await assertOwner("other");
        for (const request of await gateway.getRequests("sessions.catalog.read")) {
          expect(request.params).toMatchObject(source);
          const params = request.params as { agentId: string; sourceHomeId: string };
          expect(params.sourceHomeId).toBe(`${params.agentId}-home`);
        }
      });
    },
  );

  it("keeps old Beam links working and opens pretty shares under a non-main default agent", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 720 } }, async ({ page }) => {
      const fullId = "0123456789abcdef0123456789abcdef";
      const prettyPath = "/openclaw/beam/pretty-beam-route-0123456789ab";
      const queryPath = `/openclaw/chat/research?catalog=beam&host=gateway&thread=${fullId}`;
      const gateway = await installMockGateway(page, {
        basePath: "/openclaw",
        defaultAgentId: "research",
        featureMethods,
        methodResponses: {
          // Beam rows live in the plugin catalog, not the native session store.
          "sessions.describe": { session: null },
          "agents.list": {
            agents: [
              { id: "research", name: "Research" },
              { id: "other", name: "Other" },
            ],
            defaultId: "research",
            mainKey: "main",
          },
          "sessions.catalog.list": {
            catalogs: [
              makeCatalog(
                "beam",
                "Beam",
                fullId,
                "Pretty Beam route",
                { hostId: "gateway", label: "Beamed sessions", kind: "gateway" },
                { shareRoute: SHARE_ROUTE, status: "live", archived: false },
              ),
            ],
          },
          "sessions.catalog.read": {
            hostId: "gateway",
            label: "Pretty Beam route",
            threadId: fullId,
            items: [
              { type: "userMessage", text: "Keep this Beam URL readable." },
              { type: "agentMessage", text: "The pretty route stayed put." },
            ],
          },
        },
      });

      const assertCatalogOwner = (agentId = "research") =>
        expect
          .poll(() => paneStates(page.locator(visiblePane)))
          .toMatchObject([
            { sessionKey: `agent:${agentId}:catalog:beam:gateway:${fullId}`, owner: agentId },
          ]);
      const queryResponse = await page.goto(new URL(queryPath, suite.server.baseUrl).href);
      expect(queryResponse?.status()).toBe(200);
      const transcript = exactText(page, "The pretty route stayed put.");
      await transcript.waitFor();
      expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(queryPath);
      await assertCatalogOwner();
      const response = await page.goto(new URL(prettyPath, suite.server.baseUrl).href);
      expect(response?.status()).toBe(200);
      await transcript.waitFor();
      await assertCatalogOwner();
      expect(new URL(page.url())).toMatchObject({ pathname: prettyPath, search: "" });
      await page
        .locator(".sidebar-recent-session--active", { hasText: "Pretty Beam route" })
        .waitFor();
      await page
        .locator(".chat-pane__session-title-text", { hasText: "Pretty Beam route" })
        .waitFor();
      expect(await page.locator(`${visiblePane} textarea`).isDisabled()).toBe(true);
      const resolution = (await gateway.getRequests("sessions.catalog.list")).find(
        (request) => (request.params as { search?: string } | undefined)?.search,
      );
      expect(resolution?.params).toEqual({
        agentId: "research",
        search: "0123456789ab",
        limitPerHost: 2,
      });
      expect((await gateway.getRequests("sessions.catalog.read")).at(-1)?.params).toMatchObject({
        agentId: "research",
        catalogId: "beam",
        hostId: "gateway",
        threadId: fullId,
      });

      await page.reload();
      await transcript.waitFor();
      await assertCatalogOwner();
      expect(new URL(page.url())).toMatchObject({ pathname: prettyPath, search: "" });
      // Both previously shared IDs and stale names retain their transcript after a rename.
      for (const reference of ["0123456789ab", "old-title-0123456789ab"]) {
        await page.goto(new URL(`/openclaw/beam/${reference}`, suite.server.baseUrl).href);
        await transcript.waitFor();
        await assertCatalogOwner();
        await expect.poll(() => new URL(page.url()).pathname).toBe(prettyPath);
      }
      await page.goto(new URL("/openclaw/chat/other", suite.server.baseUrl).href);
      const beamRow = page.locator("a", { hasText: "Pretty Beam route" }).first();
      await beamRow.waitFor();
      await beamRow.click();
      await transcript.waitFor();
      await assertCatalogOwner("other");
      expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(
        `/openclaw/chat/other?catalog=beam&host=gateway&thread=${fullId}`,
      );
      expect((await gateway.getRequests("sessions.catalog.read")).at(-1)?.params).toMatchObject({
        agentId: "other",
        catalogId: "beam",
        threadId: fullId,
      });
    });
  });

  it("shows both paired-node catalogs and opens their view-only transcripts", async () => {
    const page = await suite.browser.newPage({ viewport: { width: 1440, height: 900 } });
    const pairedCatalogs = [
      { id: "opencode", label: "OpenCode", name: "OpenCode release review" },
      { id: "pi", label: "Pi", name: "Pi architecture notes" },
    ];
    const gateway = await installMockGateway(page, {
      featureMethods,
      methodResponses: {
        "sessions.catalog.list": {
          catalogs: pairedCatalogs.map(({ id, label, name }) =>
            makeCatalog(id, label, `${id}-1`, name, {
              hostId: "node:devbox",
              label: "Dev Box",
              kind: "node",
              nodeId: "devbox",
            }),
          ),
        },
        "sessions.catalog.read": {
          cases: pairedCatalogs.map(({ id, label }) => ({
            match: { catalogId: id, threadId: `${id}-1` },
            response: {
              hostId: "node:devbox",
              threadId: `${id}-1`,
              items: [{ type: "agentMessage", text: `${label} transcript loaded` }],
            },
          })),
        },
      },
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    for (const { id } of pairedCatalogs) {
      const icon = page.locator(
        `[data-session-section="catalog:${id}"] [data-provider-icon="${id}"]`,
      );
      await expect.poll(() => icon.count()).toBe(1);
    }
    const piIconResponse = await page.request.get(
      new URL("provider-icons/ProviderIcon-pi.svg", suite.server.baseUrl).toString(),
    );
    expect(piIconResponse.ok()).toBe(true);

    await exactText(page, "OpenCode release review").click();
    await expect.poll(() => page.getByText("OpenCode transcript loaded").count()).toBe(1);
    await exactText(page, "Pi architecture notes").click();
    const piPane = page.locator(visiblePane).filter({ hasText: "Pi transcript loaded" });
    await piPane.getByText("Pi transcript loaded").waitFor();
    expect(await piPane.locator(".agent-chat__composer-combobox > textarea").isDisabled()).toBe(
      true,
    );
    expect(await gateway.getRequests("sessions.catalog.read")).toHaveLength(2);
    await page.close();
  });
});
