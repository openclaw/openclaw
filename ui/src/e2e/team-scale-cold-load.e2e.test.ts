import { readFile } from "node:fs/promises";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { expect, inject, it } from "vitest";
import { startControlUiBenchGatewayServer } from "../../../scripts/lib/control-ui-bench-gateway-server.ts";
import {
  persistColdLoadWarmState,
  restoreColdLoadWarmState,
} from "../../../scripts/lib/control-ui-bench-warm-state.ts";
import { warmReloadProbe } from "../../../scripts/lib/control-ui-warm-reload-probe.ts";
import { buildSandboxHostPath } from "../../../src/agents/sandbox-host.js";
import { waitForLayoutSettled } from "../pages/chat/chat-layout.browser.test-support.ts";
import type { ChatMessageCache } from "../pages/chat/session-message-cache.ts";
import { CHAT_SNAPSHOT_PROJECTION_VERSION } from "../pages/chat/session-snapshot-record.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  createControlUiMockBootstrapConfig,
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

let http: Awaited<ReturnType<typeof startControlUiBenchGatewayServer>>;
const suite = createControlUiE2eSuite({
  name: "Team-scale cold-load fixture",
  startServer: async () => {
    const root = inject("controlUiE2eBuildRoot");
    if (!root) {
      throw new Error("Team reload proof requires the shared production UI build");
    }
    return (http = await startControlUiBenchGatewayServer(root));
  },
});

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
      await page.setViewportSize({ width: 1719, height: 1179 });
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
      liveJobName = "A refreshed scheduled check 1";
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
      await page.mouse.move(0, 0);
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
  it("paints links, thumbnail pixels, canonical notices and avatars together across a warm reload", async () => {
    const fixture = createControlUiTeamScaleFixture({
      baseUrl: suite.server.baseUrl,
      ...sandbox(""),
      transcriptMessages: 4,
      lateRowFacts: true,
    });
    sandboxAssets = fixture.assets;
    const facts = fixture.lateRowFacts!;
    const scenario = { ...fixture.scenario, deferredMethods: ["connect"] };
    http.setFixtureReader((pathname, url) => {
      if (pathname === "/control-ui-config.json") {
        return {
          body: JSON.stringify(createControlUiMockBootstrapConfig(scenario)),
          contentType: "application/json",
        };
      }
      if (pathname === "/__openclaw__/assistant-media") {
        if (url.searchParams.get("source") !== facts.cacheableImageSource) {
          return undefined;
        }
        if (url.searchParams.get("meta") === "1") {
          return { body: JSON.stringify(facts.metadata), contentType: "application/json" };
        }
        if (url.searchParams.get("mediaTicket") !== facts.metadata.mediaTicket) {
          return { body: "Ticket required", contentType: "text/plain", status: 403 };
        }
      }
      return fixture.assets.get(pathname);
    });
    await suite.withPage(
      { ...createLocalNetworkControlUiContextOptions(), viewport: { width: 1440, height: 1800 } },
      async ({ page }) => {
        const sessions = createTeamScaleSidebarListOwner(fixture.sidebarListInput);
        const gateway = await installMockGateway(page, scenario, {
          afterInitScript: `;globalThis.__name = (fn) => fn; (${warmReloadProbe.toString()})({rowFacts:true,lateRowFacts:true});`,
          requestHandlers: {
            "sessions.list": queryHandler(
              "sessions.list",
              (params) => sessions.list(params).result,
            ),
            "cron.list": queryHandler("cron.list", (params) => fixture.listCronJobs(params)),
          },
        });
        // Native HTTP, including ticketed media, must retain Chromium's real cache.
        await page.unroute("**/control-ui-config.json");
        const media = ["/api/artifacts/download/", "/__openclaw__/assistant-media"].map((path) =>
          page.waitForResponse(
            (response) =>
              response.url().includes(path) &&
              response.headers()["content-type"]?.startsWith("image/") === true,
          ),
        );
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, fixture.selectedSessionKey));
        await gateway.waitForRequest("connect");
        await gateway.resolveDeferred("connect");
        const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
        const complete = async () => {
          await thread
            .locator(".markdown-session-link--titled > .session-label")
            .filter({ hasText: facts.sessionTitle })
            .waitFor();
          await thread.locator('.markdown-github-item[data-link-reader-tone="positive"]').waitFor();
          await thread.locator('.chat-notice[data-chat-row-key^="archive:"]').waitFor();
          await page.waitForFunction(() => {
            const pane = document.querySelector(".chat-pane-cache__pane--active");
            const threadElement = pane?.querySelector(".chat-thread");
            const cache: ChatMessageCache | undefined = pane
              ? Reflect.get(pane, "chatMessagesBySession")
              : undefined;
            const thumbnails = [...(cache?.values() ?? [])]
              .flatMap(({ snapshot }) =>
                Object.values(snapshot.rowDisplay ?? {}).flatMap((row) =>
                  Object.values(row.images ?? {}),
                ),
              )
              .filter((image) => image.thumbnail instanceof Blob);
            const images = [
              ...(threadElement?.querySelectorAll<HTMLImageElement>(".chat-image-frame img") ?? []),
            ];
            const avatars = [
              ...(threadElement?.querySelectorAll<HTMLImageElement>(
                "img.chat-avatar.assistant, .chat-avatar.assistant img, .identity-avatar--agent img",
              ) ?? []),
            ];
            return (
              thumbnails.length === 2 &&
              images.length === 2 &&
              images.every(
                (image) =>
                  image.complete && image.naturalWidth === 480 && image.naturalHeight === 240,
              ) &&
              avatars.some(
                (image) => image.checkVisibility() && image.complete && image.naturalWidth > 0,
              )
            );
          });
          expect(await thread.locator(".chat-image-skeleton").count()).toBe(0);
        };
        await complete();
        for (const [index, response] of (await Promise.all(media)).entries()) {
          expect(response.headers()["cache-control"]).toBe(
            index === 0 ? "private, no-store" : "private, no-cache",
          );
          const bytes = (await response.body()).length;
          expect(bytes).toBeGreaterThanOrEqual(32 * 1024);
          expect(bytes).toBeLessThanOrEqual(96 * 1024);
        }
        await page.evaluate(async () => {
          await Reflect.get(
            document.querySelector(".chat-pane-cache__pane--active")!,
            "sessionSnapshotStore",
          ).flush();
        });
        const requests = http.requests.length;
        await page.reload();
        await gateway.waitForRequest("connect");
        await complete();
        expect(
          await thread
            .locator(".chat-image-frame img")
            .evaluateAll((images) =>
              images.map((image) => image.getAttribute("src")?.startsWith("blob:")),
            ),
        ).toEqual([true, true]);
        expect(
          http.requests
            .slice(requests)
            .filter(({ url }) => /assistant-media|artifacts\/download/.test(url)),
        ).toEqual([]);
        await gateway.resolveDeferred("connect");
        await page.waitForFunction(() =>
          Reflect.get(document.querySelector(".chat-pane-cache__pane--active")!, "transcriptReady"),
        );
        await page.screenshot({ path: `${suite.artifactDir}/complete-cached-rows.png` });
        const proof = await page.evaluate(
          () => Reflect.get(window, "__warmReload").read().lateRowFacts,
        );
        expect(proof).toMatchObject({
          measuredPaint: true,
          visualChanges: 0,
          heightDelta: 0,
          maximumHeightChange: 0,
        });
        for (const kind of ["links", "images", "notices", "avatars"]) {
          expect(proof.firstFrame[kind].length).toBeGreaterThan(0);
        }
      },
    );
  });
});
