import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createBoardWidget } from "../lib/board/widget.test-support.ts";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { requireRecord, requireString } from "./chat-flow.test-support.ts";
import { board } from "./chat-layout-fixtures.test-support.ts";
import {
  dockChatSidePanel,
  focusChatSidePanel,
  restoreChatAsMain,
} from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  captureNativeWorkspaceFailure,
  catalog,
  expectComposerFooterLayout,
  installNativeWorkspaceLitErrorTrace,
  pluginId,
  pluginModule,
  waitForPendingPluginInitializer,
  type NativePluginWindow,
} from "./native-plugin-ui.test-support.ts";
import { openHomeFullPage } from "./sidebar-navigation.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Native plugin UI ownership" });
type PluginPageRun = Parameters<typeof suite.withPage>[1];
const withPluginPage = (run: PluginPageRun) =>
  suite.withPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" }, run);
const pluginFeatureMethods = [
  ...defaultControlUiFeatureMethods,
  "plugins.controlUi.list",
  "plugins.controlUi.report",
];
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const selection = (page: Page, name: string) => page.getByRole("combobox", { name, exact: true });
const heading = (page: Page, revision: string) =>
  page.getByRole("heading", { name: `Fixture revision ${revision}` });
const outcome = (page: Page) => expect.poll(() => page.getByLabel("Fixture outcome").textContent());
const text = (page: Page, name: string) => page.getByText(name, { exact: true });
const sidebar = (page: Page, name: string) =>
  page.locator("openclaw-app-sidebar").getByRole("button", { name, exact: true });
const pluginUrl = () => `${suite.server.baseUrl}plugin?plugin=ui-fixture&id=proof`;
const composerView = "ui-fixture/composer";
async function expectAbsent(...locators: Locator[]) {
  for (const locator of locators) {
    expect(await locator.count()).toBe(0);
  }
}
async function expectPluginLoading(page: Page) {
  const panel = page.locator("openclaw-plugin-page");
  await panel.getByRole("status", { name: "Loading…", exact: true }).waitFor();
  await expectAbsent(panel.getByText("Plugin panel unavailable", { exact: true }));
}
type GatewayOptions = NonNullable<Parameters<typeof installMockGateway>[1]>;
function mockPlugin(page: Page, revision: string, options: GatewayOptions = {}) {
  return installMockGateway(page, {
    ...options,
    featureMethods: [...pluginFeatureMethods, ...(options.featureMethods ?? [])],
    methodResponses: {
      "plugins.controlUi.list": catalog(revision),
      "plugins.controlUi.report": { ok: true },
      ...options.methodResponses,
    },
  });
}
function routePlugin(page: Page, module?: string, peers = false) {
  return page.route(
    `**/__openclaw__/plugins/control-ui/${peers ? "*" : "ui-fixture"}/*/index.js`,
    (route) => {
      const parts = new URL(route.request().url()).pathname.split("/");
      const body =
        parts.at(-3) === "hung-ui" ? hungPluginModule : (module ?? pluginModule(parts.at(-2)!));
      return route.fulfill({ status: 200, contentType: "text/javascript", body });
    },
  );
}
function reloadPlugin(gateway: Awaited<ReturnType<typeof installMockGateway>>, revision: string) {
  return gateway
    .setMethodResponse("plugins.controlUi.list", catalog(revision))
    .then(() => gateway.emitGatewayEvent("plugins.controlUi.changed", { revision }));
}
const emptyCatalog = { revision: "empty", plugins: [], diagnostics: [] };
function withHungPeer(revision: string) {
  const result = catalog(revision);
  result.plugins.unshift({
    pluginId: "hung-ui",
    name: "Hung fixture",
    revision: "pending",
    entryUrl: "/__openclaw__/plugins/control-ui/hung-ui/pending/index.js",
    styles: [],
  });
  return result;
}
const sessionList = (keys: string[], fields: { agentId?: string; label?: string } = {}) => ({
  ts: 1,
  count: keys.length,
  defaults: {},
  sessions: keys.map((key) => ({ key, kind: "direct", label: key, updatedAt: 1, ...fields })),
});
const hungPluginModule = `export default { id:"hung-ui", async activate(host) {
  await host.request("fixture.peerStarted");
  await new Promise(resolve => { globalThis.nativePluginProof.release = resolve; });
  await host.request("fixture.latePeer");
} };`;

const actionPluginModule = `export default { id:"ui-fixture", activate(host) {
  const proof = globalThis.nativeActionProof = { runs: 0 };
  for (const placement of ["header", "composer", "session"]) {
    let unregister;
    const action = {
      id: placement, label: "Hold " + placement + " action", placement,
      async run(context) {
        const invocation = { signal: context.signal, done: false, outcome: "pending" };
        const gate = new Promise(resolve => { invocation.release = resolve; });
        invocation.withdraw = () => {
          unregister();
          unregister = host.ui.registerAction(action);
        };
        proof.current = invocation;
        proof.runs += 1;
        try {
          await gate;
          await context.host.request("fixture.actionContinuation", { placement });
          invocation.outcome = "completed";
        } catch (error) {
          invocation.outcome = error.message;
        } finally {
          invocation.done = true;
        }
      },
    };
    unregister = host.ui.registerAction(action);
  }
} };`;

async function selectView(page: Page, label: string, value: string) {
  await visitCustomizeUi(page);
  await page.getByRole("combobox", { name: label, exact: true }).selectOption(value);
  await returnFromCustomizeUi(page);
}

const customizationOrigins = new WeakMap<Page, string>();

async function visitCustomizeUi(page: Page) {
  const pluginsUrl = new URL("settings/plugins?tab=advanced", suite.server.baseUrl).href;
  if (page.url() !== pluginsUrl) {
    customizationOrigins.set(page, page.url());
    await page.evaluate((url) => {
      history.pushState(null, "", url);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, pluginsUrl);
    await page.getByRole("heading", { name: "Plugins", exact: true }).waitFor();
  }
  await page.locator("openclaw-plugin-manager .settings-group").waitFor();
  await expectAbsent(page.getByRole("dialog"));
}

async function returnFromCustomizeUi(page: Page) {
  const origin = customizationOrigins.get(page);
  if (origin) {
    customizationOrigins.delete(page);
    await page.goBack();
    await page.waitForURL(origin);
  }
}

suite.define(() => {
  it("retires withdrawn action registrations without reviving pending invocations on reuse", async () => {
    await withPluginPage(async ({ page }) => {
      const sessionKey = "agent:main:held-action";
      const gateway = await mockPlugin(page, "actions", {
        sessionKey,
        methodResponses: {
          "fixture.actionContinuation": { ok: true },
          "sessions.list": sessionList([sessionKey], { agentId: "main", label: "Held action" }),
        },
      });
      await routePlugin(page, actionPluginModule);
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "chat"));
      let runs = 0;
      const start = async (placement: "header" | "composer" | "session") => {
        if (placement === "session") {
          await page
            .locator(`.sidebar-recent-session[data-session-key="${sessionKey}"]`)
            .click({ button: "right" });
          await page
            .locator("openclaw-session-menu")
            .getByRole("menuitem", { name: "Hold session action", exact: true })
            .click();
        } else {
          await button(page, `Hold ${placement} action`).click();
        }
        runs += 1;
        await page.waitForFunction(
          (expected) => (window as NativePluginWindow).nativeActionProof?.runs === expected,
          runs,
        );
      };
      const finish = async () => {
        await page.waitForFunction(
          () => (window as NativePluginWindow).nativeActionProof?.current?.done === true,
        );
        return page.evaluate(
          () => (window as NativePluginWindow).nativeActionProof?.current?.outcome,
        );
      };
      const release = (withdraw = false) =>
        page.evaluate((shouldWithdraw) => {
          const invocation = (window as NativePluginWindow).nativeActionProof?.current;
          if (!invocation) {
            throw new Error("Expected a running plugin action.");
          }
          if (shouldWithdraw) {
            invocation.withdraw();
          }
          const aborted = invocation.signal.aborted;
          invocation.release();
          return aborted;
        }, withdraw);
      const retired = [];
      for (const placement of ["header", "composer", "session"] as const) {
        await start(placement);
        const before = (await gateway.getRequests("fixture.actionContinuation")).length;
        const abortedBeforeResume = await release(true);
        const result = await finish();
        const after = (await gateway.getRequests("fixture.actionContinuation")).length;
        retired.push({ placement, abortedBeforeResume, outcome: result, requests: after - before });

        await start(placement);
        await release();
        expect(await finish()).toBe("completed");
        expect(await gateway.getRequests("fixture.actionContinuation")).toHaveLength(after + 1);
      }
      expect(retired).toEqual(
        ["header", "composer", "session"].map((placement) => ({
          placement,
          abortedBeforeResume: true,
          outcome: "This plugin UI view has ended.",
          requests: 0,
        })),
      );
    });
  });

  it("recovers native widgets from initialization failure and retains healthy reloads", async () => {
    await withPluginPage(async ({ page }) => {
      const sessionKey = "agent:main:native-widget";
      const gateway = await mockPlugin(page, "pending", {
        sessionKey,
        heldMethods: ["fixture.activationStarted"],
        controlUiWidgetKinds: [{ pluginId, kind: `${pluginId}:card`, label: "Fixture widget" }],
        featureMethods: ["board.get"],
        methodResponses: {
          "board.get": {
            sessionKey,
            revision: 1,
            tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "hidden" }],
            widgets: [
              createBoardWidget({
                name: "native-card",
                title: "Native card",
                contentKind: "plugin",
                pluginKind: `${pluginId}:card`,
              }),
            ],
          },
        },
      });
      await routePlugin(page);
      const cell = page.locator('[data-widget-name="native-card"]');
      const loading = cell.getByText("Loading plugin widget…", { exact: true });
      const disabled = cell.locator('[data-test-id="board-disabled-plugin"]');
      const error = cell.locator('[data-test-id="board-widget-error"]');
      const expectHealthy = async (revision: string) => {
        await cell.getByText(`Fixture widget ${revision}`, { exact: true }).waitFor();
        await expectAbsent(loading, disabled, error);
      };
      const reload = (revision: string) => reloadPlugin(gateway, revision);

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
      await gateway.waitForRequest("fixture.activationStarted");
      await cell.locator(".board-widget__body").waitFor();
      expect(await loading.count()).toBe(1);
      await expectAbsent(disabled);

      await gateway.rejectDeferred("fixture.activationStarted", {
        message: "Widget initialization failed",
      });
      await error.waitFor();
      expect(await error.locator("code").textContent()).toContain("Widget initialization failed");
      await expectAbsent(loading, disabled);
      await gateway.setMethodResponse("plugins.controlUi.list", catalog("one"));
      await error.getByRole("button", { name: "Retry", exact: true }).click();
      await expectHealthy("one");

      const started = (await gateway.getRequests("fixture.activationStarted")).length;
      await gateway.deferNext("fixture.activationStarted");
      await reload("pending");
      await gateway.waitForRequest("fixture.activationStarted", { after: started });
      await expectHealthy("one");
      const reports = (await gateway.getRequests("plugins.controlUi.report")).length;
      await gateway.rejectDeferred("fixture.activationStarted", {
        message: "Widget reload failed",
      });
      const failed = await gateway.waitForRequest("plugins.controlUi.report", { after: reports });
      expect(failed.params).toMatchObject({
        reports: [{ pluginId, revision: "pending", status: "failed" }],
      });
      await expectHealthy("one");

      await reload("two");
      await expectHealthy("two");
      await expectAbsent(cell.getByText("Fixture widget one", { exact: true }));
      await gateway.setMethodResponse("plugins.controlUi.list", emptyCatalog);
      await gateway.emitGatewayEvent("plugins.controlUi.changed", { revision: "empty" });
      await disabled.waitFor();
      await expectAbsent(cell.getByText("Fixture widget two", { exact: true }));
      expect(await disabled.getByRole("button", { name: "Delete", exact: true }).isEnabled()).toBe(
        true,
      );

      const listed = (await gateway.getRequests("plugins.controlUi.list")).length;
      await gateway.deferNext("plugins.controlUi.list");
      await gateway.emitGatewayEvent("plugins.controlUi.changed", { revision: "retry" });
      await gateway.waitForRequest("plugins.controlUi.list", { after: listed });
      await loading.waitFor();
      await gateway.rejectDeferred("plugins.controlUi.list", {
        message: "Widget catalog temporarily unavailable",
      });
      await error.waitFor();
      expect(await error.locator("code").textContent()).toContain(
        "Widget catalog temporarily unavailable",
      );
      await expectAbsent(disabled);
      await gateway.setMethodResponse("plugins.controlUi.list", catalog("two"));
      await error.getByRole("button", { name: "Retry", exact: true }).click();
      await expectHealthy("two");
    });
  });

  it("shows loading through first activation and opens the page while another plugin is pending", async () => {
    await withPluginPage(async ({ page }) => {
      const gateway = await mockPlugin(page, "pending", {
        heldMethods: ["plugins.controlUi.list", "fixture.peerStarted"],
        methodResponses: { "plugins.controlUi.list": withHungPeer("pending") },
      });
      const bootstrapRequested = createDeferred();
      const bootstrapGate = createDeferred();
      // Startup and activation can share this request, so hold it before navigation.
      await page.route(`**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, async (route) => {
        bootstrapRequested.resolve();
        await bootstrapGate.promise;
        await route.fallback();
      });
      await routePlugin(page, pluginModule("pending"), true);
      const pluginPage = page.locator("openclaw-plugin-page");

      try {
        await page.clock.install();
        await page.goto(pluginUrl(), {
          waitUntil: "domcontentloaded",
        });
        await gateway.waitForRequest("plugins.controlUi.list");
        await expectPluginLoading(page);
        // Settings owns manager registration; merely opening its catalog leaves it unloaded.
        await button(page, "Pages").click();
        await page
          .locator(".sidebar-pages")
          .getByRole("link", { name: "Plugins", exact: true })
          .waitFor();
        expect(
          await page.evaluate(() => ({
            contributions: Boolean(customElements.get("openclaw-plugin-contributions")),
            manager: Boolean(customElements.get("openclaw-plugin-manager")),
          })),
        ).toEqual({ contributions: false, manager: false });
        await gateway.resolveDeferred("plugins.controlUi.list");
        await bootstrapRequested.promise;
        await expectPluginLoading(page);
        bootstrapGate.resolve();
        await gateway.waitForRequest("fixture.activationStarted");
        await gateway.waitForRequest("fixture.peerStarted");
        await waitForPendingPluginInitializer(page);
        await expectPluginLoading(page);
        await page.evaluate(() => {
          const release = (window as NativePluginWindow).nativePluginProof?.release;
          if (!release) {
            throw new Error("The fixture initializer has not started.");
          }
          release();
        });
        await heading(page, "pending").waitFor();
        const navigationEntry = page.locator(
          '.sidebar-pages [data-sidebar-entry="plugin:ui-fixture/proof"]',
        );
        await navigationEntry.getByRole("link", { name: "UI fixture", exact: true }).waitFor();
        expect(await navigationEntry.getAttribute("draggable")).toBe("true");
        expect(
          await navigationEntry
            .locator("openclaw-plugin-contributions")
            .evaluate((element) => getComputedStyle(element).display),
        ).toBe("contents");
        expect(
          await pluginPage.getByRole("status", { name: "Loading…", exact: true }).count(),
        ).toBe(0);
        await button(page, "Call current activation").click();
        await gateway.waitForRequest("fixture.current");
        await outcome(page).toBe("completed");
        await page.clock.fastForward(15_000);
        const activation = await gateway.waitForRequest("plugins.controlUi.report");
        expect(activation.params).toMatchObject({
          reports: expect.arrayContaining([
            expect.objectContaining({ pluginId, status: "activated" }),
            expect.objectContaining({ pluginId: "hung-ui", status: "failed" }),
          ]),
        });
        expect(await gateway.getRequests("plugins.controlUi.report")).toHaveLength(1);
      } finally {
        bootstrapGate.resolve();
      }
    });
  });

  it("loads without asset grants for auth:none and preserves canonical chat admission and view recovery", async () => {
    await withPluginPage(async ({ page }) => {
      await installNativeWorkspaceLitErrorTrace(page);
      const sessionKey = "agent:main:main";
      const otherSessionKey = "agent:main:accessory-peer";
      const draft = "Send through the canonical composer";
      const boardSnapshot = board(sessionKey);
      const gateway = await mockPlugin(page, "one", {
        sessionKey,
        pluginAssetsRequireAuth: false,
        featureMethods: ["board.get"],
        methodResponses: {
          "sessions.list": sessionList([sessionKey, otherSessionKey]),
          "board.get": {
            cases: [
              { match: { sessionKey }, response: boardSnapshot },
              {
                match: { sessionKey: otherSessionKey },
                response: { sessionKey: otherSessionKey, revision: 1, tabs: [], widgets: [] },
              },
            ],
          },
        },
      });
      await routePlugin(page, pluginModule("one"));
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "chat"));
      await sidebar(page, "Pages").click();
      await page.getByRole("link", { name: "UI fixture", exact: true }).waitFor();
      const accessories = page.locator("[data-fixture-session-accessory]");
      const accessory = accessories.filter({ hasText: sessionKey });
      const expectOneAccessory = async (key = sessionKey) => {
        await expect
          .poll(() => page.locator("[data-fixture-session-accessory]:visible").allTextContents())
          .toEqual([key]);
        expect(await accessories.filter({ hasText: key }).count()).toBe(1);
      };
      await expectOneAccessory();
      await gateway.waitForRequest("board.get");
      await gateway.emitGatewayEvent("board.command", {
        sessionKey,
        command: { kind: "focus_tab", tabId: "main" },
      });
      await page.locator(".board-session-surface:not([hidden])").waitFor();
      await expectOneAccessory();
      for (const dock of ["bottom", "right"] as const) {
        await dockChatSidePanel(page, dock);
        await expect
          .poll(() => page.locator(".sidebar-region--bottom").count())
          .toBe(dock === "bottom" ? 1 : 0);
        await expectOneAccessory();
      }
      await focusChatSidePanel(page);
      expect(await accessory.count()).toBe(1);
      await expect.poll(() => accessory.isVisible()).toBe(false);
      await sidebar(page, "Sessions").click();
      await selectChatLayoutAction(page, "Restore split");
      await expect.poll(() => page.locator(".sidebar-region--expanded").count()).toBe(0);
      await restoreChatAsMain(page);
      await expectOneAccessory();
      await sidebar(page, "Sessions").click();
      await selectChatLayoutAction(page, "Minimize side panel");
      await expect.poll(() => page.locator(".board-session-surface").isVisible()).toBe(false);
      await expectOneAccessory();
      await expectAbsent(page.getByRole("heading", { name: "Customize UI", exact: true }));
      for (const replacement of [
        "",
        "ui-fixture/delegated-composer",
        "ui-fixture/failing-composer",
      ]) {
        await selectView(page, "Composer", replacement);
        const composer = page.locator(".agent-chat__composer-shell");
        await composer.waitFor();
        expect(
          await composer.evaluate((element) =>
            Boolean(element.closest("openclaw-plugin-view[data-plugin-composer]")),
          ),
        ).toBe(replacement !== "");
        if (replacement === "ui-fixture/failing-composer") {
          await page.getByRole("alert").filter({ hasText: "Fixture composer failed" }).waitFor();
        }
        await expectComposerFooterLayout(page, composer, replacement || "Built-in");
      }
      await selectView(page, "Composer", composerView);
      const fixtureDraft = page.getByLabel("Fixture draft", { exact: true });
      await fixtureDraft.fill(draft);
      await visitCustomizeUi(page);
      const composerSelect = selection(page, "Composer");
      expect(await composerSelect.inputValue()).toBe(composerView);
      await composerSelect.selectOption("");
      await returnFromCustomizeUi(page);
      await expect
        .poll(() => page.locator(".agent-chat__composer-combobox textarea").inputValue())
        .toBe(draft);
      await expectAbsent(fixtureDraft);
      await selectView(page, "Composer", composerView);
      expect(await fixtureDraft.inputValue()).toBe(draft);
      await button(page, "Fixture send").click();
      const sent = await gateway.waitForRequest("chat.send");
      expect(sent.params).toMatchObject({ message: draft, sessionKey });
      await expect.poll(() => page.getByLabel("Send outcome").textContent()).toBe("accepted");
      await gateway.emitGatewayEvent("chat", {
        sessionKey,
        runId: requireString(requireRecord(sent.params).idempotencyKey, "sent run ID"),
        state: "error",
        errorMessage: "The fixture run failed. Please try again.",
      });
      const notice = page.locator(".chat-footer__context .chat-error");
      await notice.waitFor();
      expect(
        await notice.evaluate((element) =>
          Number.parseFloat(getComputedStyle(element).borderTopLeftRadius),
        ),
      ).toBeGreaterThan(0);
      await selectView(page, "Transcript", "ui-fixture/failing-transcript");
      const transcriptError = page
        .getByRole("alert")
        .filter({ hasText: "Fixture transcript failed" });
      await transcriptError
        .getByRole("button", { name: "Retry plugin view", exact: true })
        .waitFor();
      await selectView(page, "Workspace", "ui-fixture/default-workspace");
      await selectView(page, "Workspace", "");
      await selectView(page, "Workspace", "ui-fixture/workspace");
      try {
        await page.getByRole("heading", { name: "Custom workspace" }).waitFor();
      } catch (failure) {
        await captureNativeWorkspaceFailure(page).catch(() => {});
        throw failure;
      }
      await visitCustomizeUi(page);
      await selection(page, "Workspace").selectOption("");
      await returnFromCustomizeUi(page);
      await sidebar(page, "Pages").click();
      await page.getByRole("link", { name: "UI fixture", exact: true }).waitFor();
      await page.getByRole("link", { name: "UI fixture", exact: true }).click();
      await heading(page, "one").waitFor();
      await button(page, "Call retired composer").click();
      await outcome(page).toContain("view has ended");
      await openHomeFullPage(page);
      await expectOneAccessory();
      await sidebar(page, "Sessions").click();
      await page
        .locator(`.sidebar-recent-session[data-session-key="${otherSessionKey}"] a`)
        .click();
      await expectOneAccessory(otherSessionKey);
      await expect.poll(() => accessory.getAttribute("data-presented")).toBe("false");
      expect(await accessory.isVisible()).toBe(false);
      await openHomeFullPage(page);
      await expectOneAccessory();
      expect(await accessory.getAttribute("data-presented")).toBe("true");
    });
  });

  it("commits reloads atomically and revokes pending or retired activations", async () => {
    await withPluginPage(async ({ page }) => {
      const gateway = await mockPlugin(page, "one", {
        deferredMethods: ["plugins.controlUi.report"],
        featureMethods: ["plugins.controlUi.reload"],
        methodResponses: {
          "plugins.controlUi.reload": catalog("two"),
        },
      });
      await routePlugin(page);
      await page.goto(pluginUrl());
      const activation = await gateway.waitForRequest("plugins.controlUi.report");
      expect(activation.params).toMatchObject({
        reports: [{ pluginId, revision: "one", status: "activated" }],
      });
      await heading(page, "one").waitFor();
      await gateway.waitForRequest("plugins.controlUi.report");
      const listed = (await gateway.getRequests("plugins.controlUi.list")).length;
      await gateway.emitGatewayEvent("plugins.controlUi.changed", { revision: "one" });
      await gateway.waitForRequest("plugins.controlUi.list", { after: listed });
      await button(page, "Call current activation").click();
      await outcome(page).toBe("completed");
      expect(await gateway.getRequests("fixture.current")).toHaveLength(1);
      await gateway.resolveDeferred("plugins.controlUi.report", { ok: true });
      const reload = (revision: string) => reloadPlugin(gateway, revision);
      const readComposerSelection = async () => {
        await visitCustomizeUi(page);
        const selected = await selection(page, "Composer").inputValue();
        await returnFromCustomizeUi(page);
        return selected;
      };
      await gateway.setMethodResponse("plugins.controlUi.list", catalog("two"));
      await visitCustomizeUi(page);
      await button(page, "Reload plugin UI").click();
      await gateway.waitForRequest("plugins.controlUi.reload");
      await returnFromCustomizeUi(page);
      await heading(page, "two").waitFor();
      await expectAbsent(heading(page, "one"));
      await button(page, "Call previous activation").click();
      await outcome(page).toContain("activation has ended");
      expect(await gateway.getRequests("fixture.stale")).toHaveLength(0);
      await selectView(page, "Composer", composerView);
      const sameRevisionListed = (await gateway.getRequests("plugins.controlUi.list")).length;
      await visitCustomizeUi(page);
      const reloadButton = button(page, "Reload plugin UI");
      await reloadButton.click();
      await gateway.waitForRequest("plugins.controlUi.list", { after: sameRevisionListed });
      await expect.poll(() => reloadButton.isEnabled()).toBe(true);
      expect(await selection(page, "Composer").inputValue()).toBe(composerView);
      await returnFromCustomizeUi(page);
      await reload("broken");
      await expect
        .poll(async () =>
          (await gateway.getRequests("plugins.controlUi.report")).some((request) =>
            (request.params as { reports: Array<{ status: string }> }).reports.some(
              (report) => report.status === "failed",
            ),
          ),
        )
        .toBe(true);
      await heading(page, "two").waitFor();
      expect(await readComposerSelection()).toBe(composerView);
      await selectView(page, "Composer", "");
      const revisions = [
        ["withdrawn", "activated"],
        ["invalid-selection", "failed"],
        // A rejected revision must remain retryable.
        ["invalid-selection", "failed"],
      ] as const;
      for (const [revision, status] of revisions) {
        const reported = (await gateway.getRequests("plugins.controlUi.report")).length;
        await reload(revision);
        const receipt = await gateway.waitForRequest("plugins.controlUi.report", {
          after: reported,
        });
        expect(receipt.params).toMatchObject({ reports: [{ pluginId, revision, status }] });
        await heading(page, "withdrawn").waitFor();
        const calls = (await gateway.getRequests("fixture.current")).length;
        await button(page, "Call current activation").click();
        await gateway.waitForRequest("fixture.current", { after: calls });
        await outcome(page).toBe("completed");
        await visitCustomizeUi(page);
        for (const surface of ["Composer", "Workspace"]) {
          expect(
            await page.getByRole("combobox", { name: surface, exact: true }).inputValue(),
          ).toBe("");
        }
        if (status === "failed") {
          const { error } = (receipt.params as { reports: Array<{ error: string }> }).reports[0]!;
          expect(error).toEqual(expect.stringMatching(/\S/));
          await page
            .getByRole("alert")
            .filter({ hasText: pluginId })
            .filter({ hasText: error })
            .waitFor();
        }
        await returnFromCustomizeUi(page);
      }
      await reload("pending");
      await gateway.waitForRequest("fixture.activationStarted");
      await waitForPendingPluginInitializer(page);
      await reload("three");
      await heading(page, "three").waitFor();
      await button(page, "Release pending initializer").click();
      await outcome(page).toBe("released");
      expect(await gateway.getRequests("fixture.staleInitializer")).toHaveLength(0);
      const retiredSelections: Record<string, string> = {};
      await selectView(page, "Composer", composerView);
      await button(page, "Unregister composer").click();
      await outcome(page).toBe("completed");
      await button(page, "Register composer").click();
      retiredSelections.registration = await readComposerSelection();
      await selectView(page, "Composer", composerView);
      await button(page, "Unregister retired composer").click();
      await outcome(page).toBe("completed");
      expect(await readComposerSelection()).toBe(composerView);
      await gateway.setMethodResponse("plugins.controlUi.list", emptyCatalog);
      await gateway.emitGatewayEvent("plugins.controlUi.changed", { revision: "empty" });
      await text(page, "Plugin panel unavailable").waitFor();
      await expectAbsent(page.getByRole("link", { name: "UI fixture", exact: true }));
      await reload("three");
      await heading(page, "three").waitFor();
      retiredSelections.removal = await readComposerSelection();
      await selectView(page, "Composer", composerView);
      const connected = (await gateway.getRequests("connect")).length;
      const reported = (await gateway.getRequests("plugins.controlUi.report")).length;
      await gateway.deferNext("connect");
      await gateway.closeLatest();
      await gateway.waitForRequest("connect", { after: connected });
      const navigationSidebar = page.locator("openclaw-app-sidebar");
      for (const collapsed of [false, true]) {
        if (collapsed) {
          await page.locator('[data-navigation-view][aria-pressed="true"]').click();
        }
        await navigationSidebar.locator(".sidebar-shell").waitFor({
          state: collapsed ? "hidden" : "visible",
        });
        // Web collapse keeps navigation in the rail; the native control cluster can be empty.
        await navigationSidebar.locator(".sidebar-rail").waitFor({ state: "visible" });
        expect(await page.locator(".connection-action-block").count()).toBe(0);
        expect(await page.locator("#control-ui-main").getAttribute("inert")).toBeNull();
        expect(await page.locator("openclaw-router-outlet").getAttribute("inert")).toBeNull();
      }
      await page.locator('[data-navigation-view="pages"]').click();
      await expectPluginLoading(page);
      await gateway.resolveDeferred("connect");
      const reconnected = await gateway.waitForRequest("plugins.controlUi.report", {
        after: reported,
      });
      expect(reconnected.params).toMatchObject({
        reports: [{ pluginId, revision: "three", status: "activated" }],
      });
      await heading(page, "three").waitFor();
      retiredSelections.connection = await readComposerSelection();
      expect(retiredSelections).toEqual({ registration: "", removal: "", connection: "" });
    });
  });

  it("times out a hung initializer and releases the reload control", async () => {
    await withPluginPage(async ({ page }) => {
      const gateway = await mockPlugin(page, "one", {
        featureMethods: ["plugins.controlUi.reload"],
      });
      await routePlugin(page, undefined, true);
      await page.goto(pluginUrl());
      const activation = await gateway.waitForRequest("plugins.controlUi.report");
      expect(activation.params).toMatchObject({
        reports: [{ pluginId, revision: "one", status: "activated" }],
      });
      await heading(page, "one").waitFor();
      await page.clock.install();
      const next = withHungPeer("two");
      await gateway.setMethodResponse("plugins.controlUi.list", next);
      await gateway.setMethodResponse("plugins.controlUi.reload", next);
      await visitCustomizeUi(page);
      const reload = button(page, "Reload plugin UI");
      await reload.click();
      await gateway.waitForRequest("fixture.peerStarted");
      // Keep the manager mounted: it owns the reload button's pending state.
      expect(await reload.isDisabled()).toBe(true);
      await waitForPendingPluginInitializer(page);
      await page.clock.fastForward(15_000);
      await page
        .getByText("Plugin UI initialization timed out. Check the plugin and reload its UI.", {
          exact: false,
        })
        .waitFor();
      await expect.poll(() => reload.isEnabled()).toBe(true);
      await returnFromCustomizeUi(page);
      await heading(page, "two").waitFor();
      await button(page, "Release pending initializer").click();
      await outcome(page).toBe("released");
      expect(await gateway.getRequests("fixture.latePeer")).toHaveLength(0);
      expect(
        (await gateway.getRequests("plugins.controlUi.report")).flatMap(
          (request) => requireRecord(request.params).reports,
        ),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ pluginId, revision: "two", status: "activated" }),
          expect.objectContaining({ pluginId: "hung-ui", status: "failed" }),
        ]),
      );
    });
  });
});
