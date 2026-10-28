import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { setAvatar } from "../../../src/state/user-profile-writes.worker.ts";
import { ensureGatewayOwnerProfile } from "../../../src/state/user-profiles.ts";
import type { OpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { createDeferred } from "../../../test/helpers/promise.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import {
  waitForControlUiGatewayReady,
  waitForControlUiGatewayReconnecting,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { startScrollInferenceFixture } from "./chat-collaborator-scroll.real-gateway.test-support.ts";
import { callGateway, createChatGatewayInstance } from "./chat-real-gateway.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import {
  chooseSidebarMenuOption,
  chooseSidebarOwner,
  closeSidebarMenu,
} from "./sidebar-session-menu.test-support.ts";

/** Relay real Gateway frames unchanged; only link availability is fault-injected. */
async function installLinkFault(page: Page, baseUrl: string) {
  const gate = createDeferred();
  let blocked = false;
  let close: (() => void) | undefined;
  let connections = 0;
  const ws = new URL(baseUrl);
  ws.protocol = "ws:";
  await page.routeWebSocket(ws.origin + "/**", async (socket) => {
    connections++;
    if (blocked) {
      await gate.promise;
    }
    if (page.isClosed()) {
      return;
    }
    const server = socket.connectToServer();
    socket.onMessage((message) => server.send(message));
    server.onMessage((message) => socket.send(message));
    close = () => {
      void socket.close({ code: 1012, reason: "owned browser link loss" });
    };
  });
  return {
    disconnect() {
      expect(close).toBeDefined();
      blocked = true;
      close?.();
    },
    recover() {
      blocked = false;
      gate.resolve();
    },
    get connections() {
      return connections;
    },
  };
}

async function readSavedOwnerNamespaces(page: Page) {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open("openclaw-chat-snapshots");
        open.addEventListener(
          "error",
          () => reject(new Error("Cannot open sidebar snapshot proof", { cause: open.error })),
          { once: true },
        );
        open.addEventListener(
          "success",
          () => {
            const database = open.result;
            const transaction = database.transaction("sidebarSnapshots", "readonly");
            const request = transaction.objectStore("sidebarSnapshots").getAll();
            request.addEventListener(
              "error",
              () =>
                reject(new Error("Cannot read sidebar snapshot proof", { cause: request.error })),
              { once: true },
            );
            request.addEventListener(
              "success",
              () => {
                // SAFETY: this task-owned database is written by the real snapshot owner under test.
                const records = request.result as Array<{
                  model: {
                    sections: Array<{
                      personOwner?: { type: string; identity?: { type: string } };
                    }>;
                  };
                }>;
                resolve(
                  records.flatMap((record) =>
                    record.model.sections.flatMap((section) =>
                      section.personOwner
                        ? [section.personOwner.identity?.type ?? section.personOwner.type]
                        : [],
                    ),
                  ),
                );
              },
              { once: true },
            );
            transaction.addEventListener("complete", () => database.close(), { once: true });
          },
          { once: true },
        );
      }),
  );
}

// Real Gateway and browser; only model inference is synthetic.
let instance: OpenClawTestInstance;
let provider: Awaited<ReturnType<typeof startScrollInferenceFixture>>;
const keys = ["quiet", "stream", "attention"].map((id) => "agent:main:sidebar-live-" + id);
const suite = createControlUiE2eSuite({
  name: "Sidebar full parity with a real Gateway",
  startServerBeforeBrowser: true,
  resources: { run: async () => {}, retainedState: () => instance.stateDir },
  async startServer() {
    provider = await startScrollInferenceFixture();
    const close = () =>
      runQaGatewayFixture(
        () => instance?.cleanup(),
        () => provider.close(),
      );
    try {
      instance = await createChatGatewayInstance({
        name: "sidebar-live-parity",
        provider: "sidebar-proof",
        identity: "Field Notes",
        model: "echo",
        apiKey: "synthetic-fixture-key",
        baseUrl: "http://127.0.0.1:" + provider.port + "/v1",
        models: [{ id: "echo", name: "Deterministic local model" }],
        agents: { ownership: "explicit" },
      });
      // Keep ambient external proxy routing, but send fixture inference directly to loopback.
      const noProxy = [
        instance.env.no_proxy ?? instance.env.NO_PROXY,
        "127.0.0.1",
        "localhost",
        "::1",
      ]
        .filter(Boolean)
        .join(",");
      instance.env.NO_PROXY = noProxy;
      instance.env.no_proxy = noProxy;
      const profile = ensureGatewayOwnerProfile("Riley Morgan", { env: instance.env });
      const image = await readFile(path.join(process.cwd(), "ui/public/apple-touch-icon.png"));
      expect(setAvatar(profile.id, image, "image/png", { env: instance.env }).ok).toBe(true);
      const configuration = JSON.parse(await readFile(instance.configPath, "utf8"));
      const guideWorkspace = path.join(instance.homeDir, "guide-workspace");
      await mkdir(guideWorkspace, { recursive: true });
      await instance.state.writeConfig({
        ...configuration,
        agents: {
          ...configuration.agents,
          entries: {
            ...configuration.agents.entries,
            guide: { workspace: guideWorkspace, identity: { name: "Museum guide" } },
          },
        },
      });
      await instance.startGateway();
      for (const [i, key] of keys.entries()) {
        await callGateway(instance, "sessions.create", {
          key,
          agentId: "main",
          label: ["Museum itinerary", "Exhibit research", "Accessibility review"][i],
          visibility: "shared",
        });
      }
      await callGateway(instance, "sessions.patch", {
        key: keys[2],
        icon: "🧭",
        color: "blue",
        attention: "flag",
        statusNote: "Review accessible entrances",
        unread: true,
      });
      return { baseUrl: "http://127.0.0.1:" + instance.port + "/", close };
    } catch (error) {
      return runQaGatewayFixture(async (): Promise<never> => {
        throw error;
      }, close);
    }
  },
});

suite.define(() => {
  it("compares live, grace, offline, saved reload, recovery and new Gateway process", async () => {
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), viewport: { width: 1440, height: 900 } },
      async ({ page }) => {
        const ledger: Record<string, unknown> = {
          source: process.env.SIDEBAR_PROOF_SOURCE,
          model: "synthetic loopback Responses stream",
          gatewayPid: instance.child?.pid,
          cases: [],
        };
        const cases = ledger.cases as unknown[];
        const link = await installLinkFault(page, suite.server.baseUrl);
        await page.addInitScript(() =>
          localStorage.setItem(
            "openclaw:control-ui:community-invite",
            '{"dismissedAtMs":1770000000000}',
          ),
        );
        const url = new URL("/chat/main/sidebar-live-stream", suite.server.baseUrl);
        url.hash = new URLSearchParams({ token: instance.gatewayToken }).toString();
        const sidebar = page.locator("openclaw-app-sidebar");
        const aside = sidebar.locator("aside.sidebar");
        const sessionRow = (key: string) =>
          sidebar.locator('[data-session-key="' + key + '"]').first();
        const state = () =>
          sidebar.evaluate((root) => {
            const box = (selector: string) => {
              const r = root.querySelector(selector)?.getBoundingClientRect();
              return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
            };
            return {
              account: root.querySelector(".sidebar-identity-card__name")?.textContent?.trim(),
              brand: root.querySelector(".sidebar-agent-card__name-text")?.textContent?.trim(),
              accountAvatar: root
                .querySelector(".sidebar-identity-card .viewer-avatar")
                ?.getAttribute("data-avatar-state"),
              body: box(".sidebar-shell__body"),
              footer: box(".sidebar-shell__footer"),
              rows: [...root.querySelectorAll("[data-session-key]")].map((row) => ({
                key: row.getAttribute("data-session-key"),
                text: row.textContent?.trim(),
                classes: row.className,
                color: row.getAttribute("style"),
                icons: [
                  ...row.querySelectorAll("[role=img][aria-label], [data-session-attention]"),
                ].map(
                  (e) => e.getAttribute("data-session-attention") ?? e.getAttribute("aria-label"),
                ),
              })),
            };
          });
        const capture = async (name: string) => {
          await page.mouse.move(1000, 450);
          const value = await state();
          cases.push({
            name,
            connectionState: await aside.getAttribute("data-snapshot-state"),
            ...value,
          });
          const frame = await takeControlUiScreenshotFrame(
            page,
            aside,
            [sidebar.locator(".sidebar-identity-card"), sessionRow(keys[2]!)],
            { elements: [aside], animations: "disabled" },
          );
          await writeFile(path.join(suite.artifactDir, name + ".png"), frame.png);
          await writeFile(
            path.join(suite.artifactDir, name + "-sidebar.png"),
            frame.elements[0]!.png,
          );
          await writeFile(
            path.join(suite.artifactDir, "parity-ledger.json"),
            JSON.stringify(ledger, null, 2),
          );
          return value;
        };
        try {
          await page.goto(url.href);
          await waitForControlUiGatewayReady(page);
          await expect
            .poll(() => sidebar.locator(".sidebar-identity-card__name").textContent())
            .toContain("Riley Morgan");
          await expect
            .poll(() =>
              sidebar
                .locator(".sidebar-identity-card .viewer-avatar")
                .getAttribute("data-avatar-state"),
            )
            .toBe("loaded");
          const turn = provider.plan();
          await page
            .getByRole("textbox", { name: "Chat composer", exact: true })
            .fill("Research the museum exhibits.");
          await page.getByRole("button", { name: "Send message", exact: true }).click();
          await expect.poll(() => provider.requests()).toBe(1);
          await turn.append("Researching exhibit access.");
          await page
            .locator(".chat-group.assistant")
            .filter({ hasText: "Researching exhibit access." })
            .waitFor();
          await sessionRow(keys[0]!).locator("a.sidebar-recent-session__link").click();
          await expect.poll(() => aside.getAttribute("data-snapshot-saved")).toBe("true");
          await sidebar.getByRole("button", { name: "New personal group", exact: true }).click();
          const groupDialog = page.getByRole("dialog", { name: "New personal group", exact: true });
          await groupDialog.getByLabel("Group name", { exact: true }).fill("Museum focus");
          await groupDialog
            .getByRole("checkbox", { name: "Exhibit research", exact: true })
            .check();
          await groupDialog.getByRole("button", { name: "Save", exact: true }).click();
          await groupDialog.waitFor({ state: "hidden" });
          const focus = sidebar
            .locator("[data-personal-session-group]")
            .filter({ has: page.getByRole("list", { name: "Museum focus", exact: true }) });
          await focus.locator("[data-session-key]").waitFor();
          await expect.poll(() => aside.getAttribute("data-snapshot-saved")).toBe("true");
          const live = await capture("01-connected");
          const authoredGroups = await evaluateControlUiContext(
            page,
            ({ navigation }) => navigation.snapshot.personalSessionGroups ?? [],
          );
          link.disconnect();
          await expect
            .poll(() => page.evaluate(() => window.openclawControlUi?.snapshot().gatewayPhase))
            .toBe("reconnecting");
          const grace = await state();
          cases.push({ name: "02-disconnect-grace", ...grace });
          expect.soft(grace.body, "grace-window geometry").toEqual(live.body);
          await waitForControlUiGatewayReconnecting(page);
          const offline = await capture("03-offline");
          expect.soft(offline.body, "offline geometry").toEqual(live.body);
          expect.soft(offline.account, "offline account").toBe(live.account);
          expect.soft(offline.brand, "offline brand").toBe(live.brand);
          await page.reload();
          await expect.poll(() => aside.getAttribute("data-snapshot-state")).toBe("cached");
          const cached = await capture("04-saved-reload");
          expect
            .soft(
              await focus.locator("[data-session-key]").count(),
              "cached personal-group members",
            )
            .toBe(1);
          expect.soft(cached.body, "saved reload geometry").toEqual(live.body);
          expect.soft(cached.account, "saved reload account").toBe(live.account);
          expect.soft(cached.brand, "saved reload brand").toBe(live.brand);
          expect.soft(cached.rows, "saved row presentation").toEqual(live.rows);
          // A newer complete preference must not be replaced by the filtered cached layout.
          const authored = await evaluateControlUiContext(
            page,
            ({ navigation }, groups) => {
              navigation.update({
                personalSessionGroups: [
                  ...groups,
                  {
                    id: "newer-layout",
                    label: "Later research",
                    sessionKeys: ["agent:main:unresolved"],
                  },
                ],
              });
              return groups;
            },
            authoredGroups,
          );
          await sidebar
            .getByRole("button", { name: "Options for personal group Museum focus", exact: true })
            .click();
          await page.getByRole("menuitem", { name: "Remove personal group", exact: true }).click();
          expect(
            await evaluateControlUiContext(
              page,
              ({ navigation }) => navigation.snapshot.personalSessionGroups,
            ),
          ).toEqual([
            { id: "newer-layout", label: "Later research", sessionKeys: ["agent:main:unresolved"] },
          ]);
          await capture("04b-cached-group-removed");
          await expect.poll(() => focus.count()).toBe(0);
          await page.reload();
          await expect.poll(() => aside.getAttribute("data-snapshot-state")).toBe("cached");
          await capture("04c-cached-group-removed-reload");
          await expect.poll(() => focus.count()).toBe(0);
          await expect
            .poll(() => sidebar.locator('[data-personal-session-group="newer-layout"]').count())
            .toBe(1);
          await evaluateControlUiContext(
            page,
            ({ navigation }, groups) => navigation.update({ personalSessionGroups: groups }),
            authored,
          );
          await turn.append(" Finished while the browser was disconnected.");
          await turn.finish();
          link.recover();
          await waitForControlUiGatewayReady(page);
          await expect.poll(() => aside.getAttribute("data-snapshot-state")).toBe("live");
          const recovered = await capture("05-recovered");
          expect.soft(recovered.account).toBe(live.account);
          const firstPid = instance.child?.pid;
          await instance.stopGateway();
          await waitForControlUiGatewayReconnecting(page);
          await instance.startGateway();
          expect(instance.child?.pid).not.toBe(firstPid);
          ledger.restart = { before: firstPid, after: instance.child?.pid };
          await waitForControlUiGatewayReady(page);
          await capture("06-restarted");
          ledger.connections = link.connections;
          ledger.providerRequests = provider.requests();
          ledger.providerFailures = provider.failures;
        } finally {
          link.recover();
          await writeFile(
            path.join(suite.artifactDir, "parity-ledger.json"),
            JSON.stringify(ledger, null, 2),
          );
          console.log("SIDEBAR_LIVE_ARTIFACTS " + suite.artifactDir);
        }
      },
    );
  }, 180_000);
  it("retains Users on socket loss and saves agent-owned Person sections", async () => {
    await callGateway(instance, "sessions.assignOwner", {
      key: keys[2],
      agentId: "main",
      owner: { type: "agent", id: "main" },
    });
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const link = await installLinkFault(page, suite.server.baseUrl);
      const url = new URL("/chat/main/sidebar-live-quiet", suite.server.baseUrl);
      url.hash = new URLSearchParams({ token: instance.gatewayToken }).toString();
      const aside = page.locator("aside.sidebar");
      const ledger: Record<string, unknown> = {
        source: process.env.SIDEBAR_PROOF_SOURCE,
        cases: [],
      };
      const cases = ledger.cases as unknown[];
      const capture = async (name: string) => {
        const frame = await takeControlUiScreenshotFrame(
          page,
          aside,
          [page.locator(".sidebar-identity-card"), page.locator(".sidebar-shell__body")],
          { elements: [aside], animations: "disabled" },
        );
        await writeFile(path.join(suite.artifactDir, name + ".png"), frame.png);
        await writeFile(
          path.join(suite.artifactDir, name + "-sidebar.png"),
          frame.elements[0]!.png,
        );
      };
      const storedOwners = () => readSavedOwnerNamespaces(page);
      try {
        await page.goto(url.href);
        await waitForControlUiGatewayReady(page);
        await page.locator('[data-navigation-view="online"]').click();
        const users = page.locator("[data-online-user-id]");
        await expect.poll(() => users.count()).toBeGreaterThan(0);
        const before = await users.count();
        await capture("08-users-connected");
        cases.push({ name: "users-connected", count: before });
        link.disconnect();
        await waitForControlUiGatewayReconnecting(page);
        const after = await users.count();
        cases.push({ name: "users-offline", count: after });
        await capture("09-users-offline");
        expect.soft(after, "Users list retained offline").toBe(before);
        link.recover();
        await waitForControlUiGatewayReady(page);
        await page.locator('[data-navigation-view="sessions"]').click();
        await chooseSidebarOwner(page, "all");
        await chooseSidebarMenuOption(page, "Group by", "Person");
        await closeSidebarMenu(page);
        await page
          .locator('[data-session-key="' + keys[2] + '"]')
          .first()
          .waitFor();
        await capture("10-person-connected");
        await expect.poll(storedOwners, { timeout: 5000 }).toContain("agent");
        cases.push({ name: "person-saved-identities", types: await storedOwners() });
      } finally {
        link.recover();
        await writeFile(
          path.join(suite.artifactDir, "rich-parity-ledger.json"),
          JSON.stringify(ledger, null, 2),
        );
        console.log("SIDEBAR_RICH_ARTIFACTS " + suite.artifactDir);
      }
    });
  }, 90000);
  it("retains public roster preview and running rings through saved reload", async () => {
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), colorScheme: "dark" },
      async ({ page }) => {
        const link = await installLinkFault(page, suite.server.baseUrl);
        const url = new URL("/chat/main/sidebar-live-stream", suite.server.baseUrl);
        url.hash = new URLSearchParams({ token: instance.gatewayToken }).toString();
        const ledger: Record<string, unknown> = { source: process.env.SIDEBAR_PROOF_SOURCE };
        const capture = async (name: string) => {
          await page.mouse.move(1000, 450);
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator("aside.sidebar"),
            [page.locator(".sidebar-agent-roster"), page.locator(".sidebar-identity-card")],
            { elements: [page.locator("aside.sidebar")], animations: "disabled" },
          );
          await writeFile(path.join(suite.artifactDir, name + ".png"), frame.png);
        };
        try {
          await page.goto(url.href);
          await waitForControlUiGatewayReady(page);
          const turn = provider.plan();
          await page
            .getByRole("textbox", { name: "Chat composer", exact: true })
            .fill("Continue exhibit planning.");
          await page.getByRole("button", { name: "Send message", exact: true }).click();
          await expect.poll(() => provider.requests()).toBe(2);
          await turn.append("Planning museum access.");
          await page
            .locator(".chat-group.assistant")
            .filter({ hasText: "Planning museum access." })
            .waitFor();
          await page.locator(".sidebar-agent-card__main").click();
          await page.getByRole("menuitem", { name: "Show all", exact: true }).click();
          const group = page.locator('[data-agent-group="main"]');
          await expect
            .poll(() => group.locator(".sidebar-agent-roster__preview").textContent())
            .toContain("Finished while the browser was disconnected.");
          await expect
            .poll(() => group.locator(".session-glyph--running").count())
            .toBeGreaterThan(0);
          await expect
            .poll(() => page.locator("aside.sidebar").getAttribute("data-snapshot-saved"))
            .toBe("true");
          const before = {
            preview: await group.locator(".sidebar-agent-roster__preview").textContent(),
            rings: await group.locator(".session-glyph--running").count(),
          };
          ledger.before = before;
          await capture("11-roster-connected");
          link.disconnect();
          await waitForControlUiGatewayReconnecting(page);
          await page.reload();
          await expect
            .poll(() => page.locator("aside.sidebar").getAttribute("data-snapshot-state"))
            .toBe("cached");
          const after = {
            preview: await group
              .locator(".sidebar-agent-roster__preview")
              .textContent({ timeout: 3000 })
              .catch(() => null),
            rings: await group.locator(".session-glyph--running").count(),
          };
          ledger.after = after;
          await capture("12-roster-cached");
          expect.soft(after).toEqual(before);
          await turn.finish();
          link.recover();
          await waitForControlUiGatewayReady(page);
        } finally {
          link.recover();
          await writeFile(
            path.join(suite.artifactDir, "roster-parity-ledger.json"),
            JSON.stringify(ledger, null, 2),
          );
          console.log("SIDEBAR_ROSTER_ARTIFACTS " + suite.artifactDir);
        }
      },
    );
  }, 90000);
});
