import { expect, it } from "vitest";
import {
  controlUiSessionUrl,
  controlUiBundledSettingsStorageKey,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { captureNativePluginUiProof, catalog } from "./native-plugin-ui.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Plugin chat link routing" });
const pluginModule = `export default { id: "ui-fixture", activate(host) {
  let mounts = 0;
  host.ui.registerPage({ id: "documents", label: "Documents", mount(container, context) {
    const title = document.createElement("h1"); title.textContent = "Full document page"; container.append(title);
  }});
  host.ui.registerPanel({ id: "preview", label: "Document preview", mount(container, context) {
    mounts++;
    container.style.display = "block"; container.style.padding = "20px";
    const title = document.createElement("h2");
    const scope = document.createElement("p"); scope.dataset.fixtureScope = ""; scope.hidden = true;
    const description = document.createElement("p"); description.textContent = "A reference document opened beside this conversation.";
    const full = document.createElement("button"); full.textContent = "Open full page"; full.className = "btn";
    full.onclick = () => host.navigation.openPage({ id: "documents", params: context.props.params });
    const update = next => { context = next; title.textContent = "Document " + next.props.params?.record;
      scope.textContent = JSON.stringify({ sessionKey: next.props.sessionKey, agentId: next.props.agentId, params: next.props.params, mounts }); };
    container.append(title, description, scope, full); update(context);
    return { update, focus() { full.focus(); } };
  }});
  host.navigation.registerLinkRoute({ id: "preview", pageId: "documents", from: "chat", resolve(page) {
    return page.params?.record ? { id: "preview", params: page.params } : null;
  }});
} };`;

suite.define(() => {
  it("opens and updates an owned panel from chat without losing the conversation or draft", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, serviceWorkers: "block" },
      async ({ page }) => {
        const sessionKey = "agent:main:panel-source";
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await installMockGateway(page, {
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "plugins.controlUi.list",
            "plugins.controlUi.report",
          ],
          agentModel: "openai/gpt-4o",
          sessions: [
            { key: sessionKey, kind: "direct", label: "Document discussion", updatedAt: 1 },
          ],
          historyMessages: [
            {
              role: "assistant",
              content:
                "Read [First document](/plugin?plugin=ui-fixture&id=documents&p.agent=resource-owner&p.vault=reference&p.record=one) or [Second document](/plugin?plugin=ui-fixture&id=documents&p.agent=resource-owner&p.vault=reference&p.record=two).",
              timestamp: 1000,
            },
          ],
          methodResponses: {
            "plugins.controlUi.list": catalog("one"),
            "plugins.controlUi.report": { ok: true },
          },
        });
        await page.route("**/__openclaw__/plugins/control-ui/ui-fixture/*/index.js", (route) =>
          route.fulfill({ status: 200, contentType: "text/javascript", body: pluginModule }),
        );
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const first = page.getByRole("link", { name: "First document", exact: true });
        await first.waitFor();
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.fill("Keep this draft while I read.");
        const originalUrl = page.url();
        await captureNativePluginUiProof(suite, page, "before-panel-link.png");
        const thread = await page.locator(".chat-thread").elementHandle();
        await first.click();
        await page.getByRole("heading", { name: "Document one", exact: true }).waitFor();
        expect(page.url()).toBe(originalUrl);
        expect(await composer.inputValue()).toBe("Keep this draft while I read.");
        await page.getByRole("link", { name: "Second document", exact: true }).click();
        await page.getByRole("heading", { name: "Document two", exact: true }).waitFor();
        const scope = JSON.parse((await page.locator("[data-fixture-scope]").textContent())!);
        expect(scope).toEqual({
          sessionKey,
          agentId: "main",
          params: { agent: "resource-owner", vault: "reference", record: "two" },
          mounts: 1,
        });
        expect(await thread?.evaluate((element) => element.isConnected)).toBe(true);
        expect(await composer.inputValue()).toBe("Keep this draft while I read.");
        await captureNativePluginUiProof(suite, page, "after-panel-link.png");
        await page.getByRole("button", { name: "Open full page", exact: true }).click();
        await page.getByRole("heading", { name: "Full document page", exact: true }).waitFor();
        expect(new URL(page.url()).searchParams.get("p.record")).toBe("two");
        expect(errors).toEqual([]);
      },
    );
  });
  it("routes a base-path link from a nonselected split pane to that pane alone", async () => {
    await suite.withPage(
      { viewport: { width: 2400, height: 900 }, serviceWorkers: "block" },
      async ({ page }) => {
        const keys = ["agent:main:selected", "agent:main:origin"];
        const basePath = "/console";
        const mountUrl = new URL("console/", suite.server.baseUrl).href;
        await page.addInitScript(
          ({ storageKey, keys: paneKeys }) =>
            localStorage.setItem(
              storageKey,
              JSON.stringify({
                chatSplitLayout: {
                  activePaneId: "p1",
                  columnWeights: [0.5, 0.5],
                  columns: paneKeys.map((sessionKey, i) => ({
                    id: `c${i + 1}`,
                    paneWeights: [1],
                    panes: [{ id: `p${i + 1}`, sessionKey }],
                  })),
                },
              }),
            ),
          {
            // Gateway-scoped settings include the configured mount path.
            storageKey: `${controlUiBundledSettingsStorageKey(mountUrl)}${basePath}`,
            keys,
          },
        );
        const mountedCatalog = catalog("one");
        mountedCatalog.plugins[0]!.entryUrl = `${basePath}${mountedCatalog.plugins[0]!.entryUrl}`;
        const gateway = await installMockGateway(page, {
          basePath,
          sessionKey: keys[0],
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "plugins.controlUi.list",
            "plugins.controlUi.report",
          ],
          sessions: keys.map((key) => ({ key, kind: "direct", updatedAt: 1 })),
          historyMessages: [
            {
              role: "assistant",
              content: [
                ...Array.from({ length: 12 }, (_, i) => `Earlier reference ${i + 1}.`),
                "[Document](/console/plugin?plugin=ui-fixture&id=documents&p.record=origin)",
                ...Array.from({ length: 16 }, (_, i) => `Later reference ${i + 1}.`),
              ].join("\n\n"),
              timestamp: 1000,
            },
          ],
          methodResponses: {
            "plugins.controlUi.list": mountedCatalog,
            "plugins.controlUi.report": { ok: true },
          },
        });
        await page.route("**/__openclaw__/plugins/control-ui/ui-fixture/*/index.js", (route) =>
          route.fulfill({ status: 200, contentType: "text/javascript", body: pluginModule }),
        );
        await page.goto(controlUiSessionUrl(mountUrl, keys[0]!));
        const panes = page.locator("openclaw-chat-pane.chat-pane-cache__pane--visible");
        await expect.poll(() => panes.count()).toBe(2);
        const origin = panes.nth(1);
        const link = origin.getByRole("link", { name: "Document", exact: true });
        await link.waitFor();
        const activation = await gateway.waitForRequest("plugins.controlUi.report");
        expect(activation.params).toMatchObject({ status: "activated" });
        await link.evaluate((anchor) => anchor.scrollIntoView({ block: "center" }));
        const thread = origin.locator(".chat-thread");
        await expect.poll(() => thread.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        const scrollTop = await thread.evaluate((element) => element.scrollTop);
        expect(
          await thread.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        ).toBeGreaterThan(0);
        // A synthetic click deliberately omits pointer/focus selection. The chat's own
        // context must route the link while the other pane is still globally selected.
        await link.evaluate((anchor) => (anchor as HTMLAnchorElement).click());
        await origin.getByRole("heading", { name: "Document origin", exact: true }).waitFor();
        expect(await panes.nth(0).locator("[data-fixture-scope]").count()).toBe(0);
        await expect
          .poll(() => thread.evaluate((element) => element.scrollTop))
          .toBeCloseTo(scrollTop, 0);
        expect(
          JSON.parse((await origin.locator("[data-fixture-scope]").textContent())!).sessionKey,
        ).toBe(keys[1]);
      },
    );
  });
});
