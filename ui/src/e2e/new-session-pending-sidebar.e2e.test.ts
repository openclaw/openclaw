import { expect, it } from "vitest";
import type { MockGatewayWindow } from "../test-helpers/control-ui-e2e-contract.ts";
import { controlUiBundledSettingsStorageKey } from "../test-helpers/control-ui-e2e.ts";
import { getInitialHistoryRequests } from "./chat-initial-history.test-support.ts";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
  navigateInApp,
  waitForCommittedChatRoute,
  controlUiSessionPath,
  pollValue,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it.each([
    { destination: "chip", mode: "chip", pinned: false },
    { destination: "roster", mode: "roster", pinned: false },
    { destination: "pinned agent", mode: "roster", pinned: true },
  ] as const)(
    "shows a provisional row only where the admitted row appears ($destination) and restores the draft on rejection",
    async ({ mode, pinned }) => {
      await suite.withPage(
        { viewport: { width: 1280, height: 900 }, colorScheme: "dark" },
        async ({ page }) => {
          await page.addInitScript(
            ({ key, sidebarAgentsMode, pinnedAgentIds }) =>
              localStorage.setItem(key, JSON.stringify({ sidebarAgentsMode, pinnedAgentIds })),
            {
              key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
              sidebarAgentsMode: mode,
              pinnedAgentIds: pinned ? ["main"] : [],
            },
          );
          const old = {
            key: "agent:main:planning",
            sessionId: "planning",
            kind: "direct",
            label: "Weekly planning",
            updatedAt: 1,
          };
          const gateway = await installMockGateway(page, { sessionKey: old.key, sessions: [old] });
          await page.goto(new URL(controlUiSessionPath(old.key), suite.server.baseUrl).href);
          const oldRow = page.locator('[data-session-key="' + old.key + '"]');
          const currentDestination =
            mode === "chip"
              ? oldRow.locator('.sidebar-recent-session__link[aria-current="page"]')
              : page.locator(
                  pinned
                    ? '[data-pinned-agent="main"]'
                    : '.sidebar-agent-roster__group[data-agent-group="main"]',
                );
          await currentDestination.waitFor();
          if (mode !== "chip") {
            expect(await oldRow.count()).toBe(0);
          }
          await navigateInApp(page, "new-session", "?agent=main");
          const message = page.locator(".new-session-page__message");
          const prompt = "Review release readiness and outstanding fixes";
          await message.fill(prompt);
          await gateway.deferNext("sessions.create");
          await page.getByRole("button", { name: "Start session", exact: true }).click();
          await gateway.waitForRequest("sessions.create");
          await page.locator("openclaw-pending-session-create .chat-pane__header").waitFor();
          const provisional = page.locator(".sidebar-recent-session--creating");
          if (mode === "chip") {
            await expect.poll(() => provisional.count()).toBe(1);
          } else {
            // Agent-only rosters must not flash a row they will not retain after admission.
            await page.locator('[data-agent-id="main"]').waitFor();
            expect(await provisional.count()).toBe(0);
          }
          if (mode === "chip") {
            const handoffSlot = page.locator(
              ".sidebar-sessions .sidebar-recent-sessions .sidebar-recent-session--creating",
            );
            expect(await handoffSlot.count()).toBe(1);
            const titleInset = (row: typeof provisional) =>
              row
                .locator(".sidebar-recent-session__text")
                .evaluate((element) => Math.round(element.getBoundingClientRect().left));
            expect(await titleInset(provisional)).toBe(await titleInset(oldRow));
            const bounds = (row: typeof provisional) =>
              row.evaluate((element) => element.getBoundingClientRect().toJSON() as DOMRect);
            const [pendingBox, oldBox] = [await bounds(provisional), await bounds(oldRow)];
            expect(Math.round(oldBox.top - pendingBox.bottom)).toBe(2);
            expect(await provisional.locator('[aria-current="page"]').count()).toBe(1);
            expect(
              await provisional.locator(".sidebar-recent-session__link").getAttribute("aria-busy"),
            ).toBe("true");
            expect(await oldRow.locator('[aria-current="page"]').count()).toBe(0);
            expect(await provisional.locator("button, a[href]").count()).toBe(0);
            expect(await provisional.locator(".session-title-placeholder").count()).toBe(1);
          }
          const bars = provisional
            .locator(".session-title-placeholder > span")
            .or(
              page
                .locator("openclaw-pending-session-create .session-title-placeholder > span")
                .filter({ visible: true }),
            );
          expect(await bars.count()).toBe(mode === "chip" ? 2 : 1);
          for (const bar of await bars.all()) {
            expect(
              await bar.evaluate((element) => getComputedStyle(element, "::after").animationName),
            ).toBe("shimmer");
          }
          await page.emulateMedia({ reducedMotion: "reduce" });
          for (const bar of await bars.all()) {
            expect(
              await bar.evaluate((element) => getComputedStyle(element, "::after").animationName),
            ).toBe("none");
          }
          expect(await getInitialHistoryRequests(gateway)).toHaveLength(1);
          await gateway.rejectDeferred("sessions.create", {
            code: "UNAVAILABLE",
            message: "Synthetic admission refused",
          });
          await pollValue(message).toBe(prompt);
          expect(await provisional.count()).toBe(0);
          expect(await page.locator('.sidebar-recent-session [aria-current="page"]').count()).toBe(
            0,
          );
          await navigateInApp(page, "chat");
          await waitForCommittedChatRoute(page);
          if (mode === "chip") {
            await oldRow.locator('[aria-current="page"]').waitFor();
          } else {
            expect(await currentDestination.count()).toBe(1);
          }
        },
      );
    },
  );

  it("keeps a group-targeted provisional row in that group through admission", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, colorScheme: "dark" },
      async ({ page }) => {
        const row = (key: string, label: string, updatedAt: number, category?: string) => ({
          key,
          sessionId: key.split(":").at(-1),
          kind: "direct",
          label,
          updatedAt,
          ...(category ? { category } : {}),
        });
        const sessions = [
          row("agent:main:gateway", "Start clean gateway", 3, "Claws"),
          row("agent:main:audit", "Audit model usage", 2, "ClawHub"),
          row("agent:main:other", "Chat catch-up panel", 1),
        ];
        const gateway = await installMockGateway(page, {
          sessionKey: "agent:main:other",
          sessions,
          sessionGroups: ["Claws", "ClawHub"],
          featureMethods: [
            "chat.startup",
            "sessions.create",
            "sessions.groups.list",
            "sessions.groups.put",
          ],
        });
        await page.goto(
          new URL(controlUiSessionPath("agent:main:other"), suite.server.baseUrl).href,
        );
        const claws = page.locator('[data-session-section="category:Claws"]');
        const existing = claws.locator('[data-session-key="agent:main:gateway"]');
        await existing.waitFor();
        await navigateInApp(page, "new-session", "?agent=main&group=Claws");
        await page.locator(".new-session-page__message").fill("Draft the next release notes");
        await gateway.deferNext("sessions.create");
        await page.getByRole("button", { name: "Start session", exact: true }).click();
        const create = await gateway.waitForRequest("sessions.create");
        const params = create.params as { key: string; category?: string };
        expect(params.category).toBe("Claws");

        const provisional = page.locator(".sidebar-recent-session--creating");
        await expect.poll(() => provisional.count()).toBe(1);
        expect(await claws.locator(".sidebar-recent-session--creating").count()).toBe(1);
        const top = (locator: typeof provisional) =>
          locator.evaluate((element) => Math.round(element.getBoundingClientRect().top));
        const provisionalTop = await top(provisional);
        expect(provisionalTop).toBeLessThan(await top(existing));

        await page.evaluate(() => {
          const replies: Array<(payload: unknown) => void> = [];
          Reflect.set(window, "heldCreateLists", replies);
          const mock = (window as MockGatewayWindow).openclawControlUiE2eGateway!;
          mock.setRequestHandler("sessions.list", ({ respond }) => replies.push(respond));
          mock.setRequestHandler("sessions.describe", () => {});
        });
        const accepted = row(params.key, "Draft the next release notes", 4, "Claws");
        await gateway.setMethodResponse("chat.startup", {
          messages: [],
          sessionId: accepted.sessionId,
        });
        await gateway.resolveDeferred("sessions.create", {
          key: params.key,
          entry: { ...accepted, displayName: accepted.label },
        });
        await expect
          .poll(() => new URL(page.url()).pathname)
          .toContain(params.key.split(":").at(-1)!.replaceAll("-", ""));
        await expect.poll(() => provisional.count()).toBe(1);
        expect(await provisional.textContent()).toContain(accepted.label);
        const title = page
          .locator("openclaw-chat-pane .chat-pane__session-title-text")
          .filter({ hasText: accepted.label });
        await title.waitFor({ state: "visible" });
        expect(await provisional.locator('[aria-busy="true"]').count()).toBe(0);
        expect(await top(provisional)).toBe(provisionalTop);
        expect(await claws.locator(`[data-session-key="${params.key}"]`).count()).toBe(0);
        await gateway.setSessionsListResponse({ sessions: [accepted, ...sessions] });
        await page.evaluate(
          (listedSessions) => {
            const replies = Reflect.get(window, "heldCreateLists") as Array<
              (payload: unknown) => void
            >;
            const payload = {
              sessions: listedSessions,
              count: listedSessions.length,
              ts: Date.now(),
              path: "",
              defaults: {},
            };
            (window as MockGatewayWindow).openclawControlUiE2eGateway!.setRequestHandler(
              "sessions.list",
              ({ respond }) => respond(payload),
            );
            for (const reply of replies) {
              reply(payload);
            }
          },
          [accepted, ...sessions],
        );
        const admitted = claws.locator(`[data-session-key="${params.key}"]`);
        await admitted.waitFor();
        await expect.poll(() => provisional.count()).toBe(0);
        expect(await top(admitted)).toBe(provisionalTop);
      },
    );
  });
});
