import { readFile } from "node:fs/promises";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  persistColdLoadWarmState,
  restoreColdLoadWarmState,
} from "../../../scripts/lib/control-ui-bench-warm-state.ts";
import { buildSandboxHostPath } from "../../../src/agents/sandbox-host.js";
import { waitForLayoutSettled } from "../pages/chat/chat-layout.browser.test-support.ts";
import { CHAT_SNAPSHOT_PROJECTION_VERSION } from "../pages/chat/session-snapshot-projection.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
  navigateToControlUiSession,
} from "../test-helpers/control-ui-e2e.ts";
import { createTeamScaleSidebarListOwner } from "../test-helpers/control-ui-sidebar-list-fixture.ts";
import {
  createControlUiTeamScaleFixture,
  TEAM_SCALE_SELF_INSTANCE_ID,
} from "../test-helpers/control-ui-team-scale-fixture.ts";
import { useCanvasSandboxFixture } from "./canvas-sandbox.test-support.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import { layoutBox } from "./chat-presentation.test-support.ts";
import { createLocalNetworkControlUiContextOptions } from "./control-ui-browser-options.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Team-scale cold-load fixture" });

function observeStoreWrite(
  page: Page,
  observation:
    | { store: "sidebarSnapshots"; people: number }
    | { store: "composerDrafts"; text: string },
) {
  return page.evaluateHandle((expected) => {
    // oxlint-disable-next-line typescript/unbound-method -- call(this, value, key) preserves each store receiver.
    const put = IDBObjectStore.prototype.put;
    return {
      done: new Promise<void>((resolve) => {
        IDBObjectStore.prototype.put = function (
          this: IDBObjectStore,
          value: { text?: string; model?: { navigationView?: string; onlineUsers?: unknown[] } },
          key?: IDBValidKey,
        ) {
          const request = put.call(this, value, key);
          if (
            this.name === expected.store &&
            (expected.store === "composerDrafts"
              ? value.text === expected.text
              : value.model?.navigationView === "online" &&
                value.model.onlineUsers?.length === expected.people)
          ) {
            IDBObjectStore.prototype.put = put;
            this.transaction.addEventListener("complete", () => resolve(), { once: true });
          }
          return request;
        };
      }),
    };
  }, observation);
}

async function readStoredWarmState({
  sessionKey,
  includeDrafts = false,
}: {
  sessionKey: string;
  includeDrafts?: boolean;
}) {
  const result = <T>(request: IDBRequest<T>) =>
    new Promise<T>((resolve, reject) => {
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener(
        "error",
        () => reject(request.error ?? new Error("IndexedDB request failed")),
        { once: true },
      );
    });
  const database = await result(indexedDB.open("openclaw-chat-snapshots"));
  try {
    const transaction = database.transaction(["snapshots", "sidebarSnapshots"]);
    const readAll = <T>(name: string): Promise<T[]> =>
      result(transaction.objectStore(name).getAll());
    const [records, sidebars] = await Promise.all([
      readAll<{ sessionKey: string; snapshot: { messages: unknown[] } }>("snapshots"),
      readAll<{ sessionKey: string; model: { onlineUsers: unknown[] } }>("sidebarSnapshots"),
    ]);
    const record = records.find((entry) => entry.sessionKey.endsWith(`\u0000${sessionKey}`));
    if (!record) {
      throw new Error("Selected transcript was not persisted");
    }
    const sidebar = sidebars.find((entry) =>
      entry.sessionKey.startsWith(`${record.sessionKey.split("\u0000")[0]}\u0000sidebar:`),
    );
    if (!sidebar) {
      throw new Error("Selected sidebar was not persisted");
    }
    let drafts: number | null = null;
    if (includeDrafts) {
      const controls = await result(indexedDB.open("openclaw-control-ui"));
      try {
        drafts = await result(
          controls.transaction("composerDrafts").objectStore("composerDrafts").count(),
        );
      } finally {
        controls.close();
      }
    }
    return { transcript: record.snapshot, sidebar: sidebar.model, drafts };
  } finally {
    database.close();
  }
}

function queryHandler(method: string, run: (params: Record<string, unknown>) => unknown) {
  return (value: unknown) => {
    const params = asRecord(value);
    if (!params) {
      throw new Error(method + " requires query parameters");
    }
    return run(params);
  };
}

suite.define(() => {
  let sandboxAssets: ReturnType<typeof createControlUiTeamScaleFixture>["assets"] | undefined;
  const sandbox = useCanvasSandboxFixture((pathname) => sandboxAssets?.get(pathname));

  it("loads a paged Team roster, pinned MCP dashboard, plugins, and inline widgets through a deep link", async () => {
    const sandboxConfig = sandbox("");
    const fixture = createControlUiTeamScaleFixture({
      baseUrl: suite.server.baseUrl,
      ...sandboxConfig,
      sandboxUrl: buildSandboxHostPath({
        blockDescendantFrames: true,
        resourceDomains: [`http://127.0.0.1:${sandboxConfig.sandboxPort}`],
      }),
      dashboardMcpApp: {
        font: await readFile(
          new URL("../../public/fonts/space-grotesk-latin.woff2", import.meta.url),
        ),
      },
    });
    sandboxAssets = fixture.assets;
    await suite.withPage(createLocalNetworkControlUiContextOptions(), async ({ page }) => {
      await page.route("**/__openclaw__/**", async (route) => {
        const asset = fixture.assets.get(new URL(route.request().url()).pathname);
        if (asset) {
          await route.fulfill({ status: 200, ...asset });
        } else {
          await route.fallback();
        }
      });
      await page.addInitScript(
        ({ key, entries }) => {
          if (window !== window.top || localStorage.getItem(key)) {
            return;
          }
          localStorage.setItem(
            key,
            JSON.stringify({
              sidebarAgentsMode: "chip",
              railShortcuts: entries,
              navigationByProfile: { "team-person-001": { railShortcuts: entries } },
            }),
          );
        },
        {
          key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
          entries: fixture.sidebarEntries,
        },
      );
      const sessions = createTeamScaleSidebarListOwner(fixture.sidebarListInput);
      let liveJobName: string = fixture.cronJobs[0]!.name;
      const gateway = await installMockGateway(
        page,
        {
          ...fixture.scenario,
          deferredMethods: ["connect"],
          featureMethods: [...fixture.scenario.featureMethods!, "progressCard.refresh"],
        },
        {
          requestHandlers: {
            "sessions.list": queryHandler(
              "sessions.list",
              (params) => sessions.list(params).result,
            ),
            "cron.list": queryHandler("cron.list", (params) => {
              const result = fixture.listCronJobs(params);
              return {
                ...result,
                jobs: result.jobs.map((job) =>
                  job.id === fixture.cronJobs[0]!.id
                    ? Object.assign({}, job, { name: liveJobName })
                    : job,
                ),
              };
            }),
          },
        },
      );
      await page.goto(
        controlUiSessionUrl(suite.server.baseUrl, fixture.selectedSessionKey, "dashboard"),
      );
      const connectRequest = await gateway.waitForRequest("connect");
      await gateway.resolveDeferred("connect");
      await page.locator(".chat-pane__header").first().waitFor();
      const instanceId = asRecord(asRecord(connectRequest.params)?.client)?.instanceId;
      expect(typeof instanceId).toBe("string");
      const ownPresence = <T extends { instanceId?: string }>(entry: T) =>
        Object.assign({}, entry, {
          instanceId:
            entry.instanceId === TEAM_SCALE_SELF_INSTANCE_ID ? instanceId : entry.instanceId,
        });
      for (const frame of fixture.events) {
        if (frame.event === "presence") {
          await gateway.emitGatewayEvent("presence", {
            presence: frame.payload.presence.map(ownPresence),
          });
        }
      }
      const sidebar = page.locator("openclaw-app-sidebar");
      await page.evaluate("globalThis.__name = (fn) => fn");
      const onlineWrite = await observeStoreWrite(page, {
        store: "sidebarSnapshots",
        people: 120,
      });
      await sidebar.locator('[data-navigation-view="online"]').click();
      await sidebar.locator('[data-online-user-id="team-person-120"]').waitFor();
      expect(await sidebar.locator("[data-online-user-id]").count()).toBe(120);
      await onlineWrite.evaluate(({ done }) => done);
      await onlineWrite.dispose();

      const dashboard = page
        .frameLocator("openclaw-board-view mcp-app-view iframe")
        .frameLocator("iframe");
      await dashboard.getByText("Team metric 1", { exact: true }).waitFor();
      await dashboard.getByRole("img", { name: "Synthetic chart 4", exact: true }).waitFor();
      expect(await dashboard.getByRole("img", { name: /^Synthetic chart / }).count()).toBe(4);
      const fontState = await dashboard.locator("body").evaluate(async () => {
        await document.fonts.ready;
        return [...document.fonts].map(({ family, status }) => ({ family, status }));
      });
      expect(fontState).toContainEqual({ family: "TeamMetric", status: "loaded" });
      const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
      // Use the gutter outside widget frames and sample after native wheel delivery.
      await thread.hover({ position: { x: 24, y: 24 } });
      const coverage = await thread.evaluateHandle((element) => {
        const initialTop = element.scrollTop;
        const padding = getComputedStyle(element);
        const topPadding = Number.parseFloat(padding.paddingTop);
        const bottomPadding = Number.parseFloat(padding.paddingBottom);
        const wheel = new Promise<void>((resolve) => {
          element.addEventListener("wheel", () => resolve(), { once: true, passive: true });
        });
        return {
          sample: wheel.then(async () => {
            const frames: Array<{ scrollTop: number; covered: boolean }> = [];
            for (let frame = 0; frame < 20; frame++) {
              await new Promise<void>((resolve) => {
                requestAnimationFrame(() => resolve());
              });
              const viewport = element.getBoundingClientRect();
              const rows = [...element.querySelectorAll(".chat-virtual-row")].map((row) =>
                row.getBoundingClientRect(),
              );
              frames.push({
                scrollTop: element.scrollTop,
                covered:
                  Math.min(...rows.map((row) => row.top)) <= viewport.top + topPadding + 1 &&
                  Math.max(...rows.map((row) => row.bottom)) >= viewport.bottom - bottomPadding - 1,
              });
            }
            return { initialTop, frames };
          }),
        };
      });
      await page.mouse.wheel(0, -1800);
      const sampled = await coverage.evaluate(({ sample }) => sample);
      await coverage.dispose();
      expect(sampled.frames.some((frame) => frame.scrollTop < sampled.initialTop)).toBe(true);
      expect(
        sampled.frames.every((frame) => frame.covered),
        JSON.stringify(sampled),
      ).toBe(true);

      await navigateToControlUiSession(page, fixture.selectedSessionKey);
      await sidebar.locator('[data-navigation-view="online"]').click();
      await sidebar.locator('[data-online-user-id="team-person-120"]').waitFor();
      const details = await openChatDetails(page);
      const sectionSelector = '[data-details-group], [data-progress-card-placement="details"]';
      const sections = details.locator(sectionSelector);
      const sectionOrder = () =>
        sections.evaluateAll((rows) =>
          rows.map((row) => row.getAttribute("data-details-group") ?? "progress"),
        );
      const expectedSections = ["people", "subagents", "outputs", "progress", "automations"];
      const controls = [
        [details.locator(".task-progress-details__refresh"), "progressCard.refresh"],
        [details.locator(".chat-summary__automation-more"), "cron.list"],
      ] as const;
      await details.getByText(liveJobName, { exact: true }).waitFor();
      await controls[0][0].waitFor();
      await expect.poll(sectionOrder).toEqual(expectedSections);
      await details.locator(".chat-details-people__preview-avatar").first().waitFor();
      const geometry = async () => Promise.all([details, ...(await sections.all())].map(layoutBox));
      const appearance = () =>
        details
          .locator(".task-progress-details__refresh, .chat-summary__automation-more")
          .evaluateAll((buttons) =>
            buttons.map((button) => {
              const style = getComputedStyle(button);
              return [button.className, style.opacity, style.color, style.cursor];
            }),
          );
      const warmInput: Parameters<typeof persistColdLoadWarmState>[0] = {
        sessionKey: fixture.selectedSessionKey,
        sidebarView: "online",
      };
      const warm = await page.evaluate(persistColdLoadWarmState, warmInput);
      expect(warm).toMatchObject({
        databaseVersion: 8,
        projectionVersion: CHAT_SNAPSHOT_PROJECTION_VERSION,
        sidebarView: "online",
        sidebarPeople: 120,
      });
      expect(warm.messages).toBeLessThanOrEqual(80);
      expect(warm.messages).toBeGreaterThan(0);
      const baseline = await page.evaluate(readStoredWarmState, warmInput);
      const mutation = "Synthetic warm snapshot mutation";
      await gateway.emitChatFinal({
        sessionKey: fixture.selectedSessionKey,
        runId: "team-scale-warm-reset",
        text: mutation,
      });
      await page.waitForFunction(
        ({ sessionKey, text }) => {
          const pane = document.querySelector(".chat-pane-cache__pane--active");
          const cache: Map<string, { snapshot: { messages: unknown[] } }> | undefined = pane
            ? Reflect.get(pane, "chatMessagesBySession")
            : undefined;
          const entry = cache && [...cache].find(([key]) => key.endsWith(`\u0000${sessionKey}`));
          return Boolean(entry && JSON.stringify(entry[1].snapshot.messages).includes(text));
        },
        { sessionKey: fixture.selectedSessionKey, text: mutation },
      );
      await page.evaluate(persistColdLoadWarmState, warmInput);
      const presence = fixture.events.find((frame) => frame.event === "presence");
      if (!presence) {
        throw new Error("The Team fixture must include presence events");
      }
      const sidebarWrite = await observeStoreWrite(page, {
        store: "sidebarSnapshots",
        people: 119,
      });
      await gateway.emitGatewayEvent("presence", {
        presence: presence.payload.presence
          .filter((entry) => entry.user?.id !== "team-person-120")
          .map(ownPresence),
      });
      await sidebar.locator('[data-online-user-id="team-person-120"]').waitFor({
        state: "detached",
      });
      expect(await sidebar.locator("[data-online-user-id]").count()).toBe(119);
      await sidebarWrite.evaluate(({ done }) => done);
      await sidebarWrite.dispose();
      const mutated = await page.evaluate(readStoredWarmState, warmInput);
      expect(JSON.stringify(mutated.transcript)).toContain(mutation);
      expect(mutated.sidebar).not.toEqual(baseline.sidebar);
      const draftWrite = await observeStoreWrite(page, {
        store: "composerDrafts",
        text: "Synthetic streaming input",
      });
      const composer = page.locator(".agent-chat__composer-combobox textarea").last();
      await composer.fill("Synthetic streaming input");
      await draftWrite.evaluate(({ done }) => done);
      await draftWrite.dispose();
      const leavingWarm = await page.evaluate(persistColdLoadWarmState, warmInput);
      const exitKey = "control-ui-bench-exit";
      await page.evaluate((key) => {
        window.addEventListener("pagehide", () => localStorage.setItem(key, "saved"));
      }, exitKey);
      await restoreColdLoadWarmState(page, warm.storage, leavingWarm.storage);
      expect(leavingWarm.storage.local).toContainEqual([exitKey, "saved"]);
      expect(await page.evaluate((key) => localStorage.getItem(key), exitKey)).toBeNull();
      await page.evaluate((key) => localStorage.setItem(key, "measured-change"), exitKey);
      await restoreColdLoadWarmState(page, leavingWarm.storage);
      expect(await page.evaluate((key) => localStorage.getItem(key), exitKey)).toBe("saved");
      await restoreColdLoadWarmState(page, warm.storage);
      expect(
        await page.evaluate(readStoredWarmState, { ...warmInput, includeDrafts: true }),
      ).toEqual({ ...baseline, drafts: 0 });
      liveJobName = "Updated scheduled check 1";
      // The reset document reloads an exact-key link independently of short-link discovery.
      await page.evaluate(
        (url) => history.replaceState(null, "", url),
        controlUiSessionUrl(suite.server.baseUrl, fixture.selectedSessionKey),
      );
      await page.reload();
      await gateway.waitForRequest("connect");
      await details.getByText("Synthetic scheduled check 1", { exact: true }).waitFor();
      expect(await sectionOrder()).toEqual(expectedSections);
      expect(await details.locator("openclaw-panel-loading-skeleton").count()).toBe(0);
      expect(await details.locator(".chat-details-people__preview-avatar").count()).toBeGreaterThan(
        0,
      );
      expect(
        await details
          .locator('[data-details-group="outputs"] .chat-details-desktop-section__count')
          .textContent(),
      ).toBe("·1");
      const cachedAppearance = await appearance();
      const chatUrl = page.url();
      for (const [control, method] of controls) {
        expect(await control.getAttribute("aria-disabled")).toBe("true");
        expect(await control.getAttribute("disabled")).toBeNull();
        // Forced inputs still need settled disclosure geometry to hit their intended controls.
        await control.scrollIntoViewIfNeeded();
        await waitForLayoutSettled(
          page,
          ".chat-details :is(.chat-details-desktop-section__body, button, a)",
        );
        await control.click({ force: true });
        for (const key of ["Enter", "Space"]) {
          await control.press(key);
        }
        expect(page.url()).toBe(chatUrl);
        expect(await gateway.getRequests(method)).toHaveLength(0);
      }
      const retained = await details
        .locator(
          `${sectionSelector}, .task-progress-details__refresh, .chat-summary__automation-more`,
        )
        .elementHandles();
      await waitForLayoutSettled(page, ".chat-details-desktop-body__content");
      const before = await geometry();
      await gateway.resolveDeferred("connect");
      await details.getByText(liveJobName, { exact: true }).waitFor();
      for (const [control] of controls) {
        await expect.poll(() => control.getAttribute("aria-disabled")).toBeNull();
      }
      await waitForLayoutSettled(page, ".chat-details-desktop-body__content");
      expect(await geometry()).toEqual(before);
      expect(await appearance()).toEqual(cachedAppearance);
      expect(await gateway.getRequests("progressCard.refresh")).toHaveLength(0);
      for (const element of retained) {
        expect(await element.evaluate((node) => node.isConnected)).toBe(true);
        await element.dispose();
      }
      await sidebar.locator('[data-navigation-view="online"][aria-pressed="true"]').waitFor();
      await sidebar.locator('[data-online-user-id="team-person-120"]').waitFor();
      expect(await sidebar.locator("[data-online-user-id]").count()).toBe(120);
      expect(await composer.inputValue()).toBe("");
      await page.locator(".chat-pane__header").first().waitFor();
    });
  });
});
