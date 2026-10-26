import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import * as ui from "./session-management.compact.test-support.ts";
import * as support from "./session-management.test-support.ts";

const suite = support.createSessionManagementE2eSuite();

suite.define(() =>
  it.each([
    { status: "running", label: "Active run", playState: "running" },
    { status: "queued", label: "Queued", playState: "paused" },
  ])("shows a $playState ring for $status work", ({ status, label, playState }) =>
    ui.withSessionPage(
      suite,
      async (page) => {
        const mainKey = "agent:main:main";
        const queuedKey = "agent:main:queued-repair";
        const workRow = (runStatus: string, extra: { unread?: boolean } = {}) =>
          sessionRow(queuedKey, "Queued repair", 1, {
            hasActiveRun: true,
            status: runStatus,
            ...extra,
          });
        const gateway = await ui.installSessionRows(
          page,
          [sessionRow(mainKey, "Main", 2), workRow(status)],
          { sessionKey: mainKey },
        );

        await page.goto(support.controlUiSessionUrl(suite.server.baseUrl, mainKey));
        const row = page.locator(`[data-session-key="${queuedKey}"]`);
        await row.waitFor({ state: "visible", timeout: 10_000 });
        const waiting = row.getByText("Waiting for a concurrency slot", { exact: true });
        expect(await waiting.count()).toBe(0);
        expect(await row.locator(".sidebar-recent-session__subtitle").count()).toBe(0);
        const ring = row.locator(".sidebar-session-indicator .session-glyph__ring");
        const ringState = () =>
          ring.evaluateAll((rings) =>
            rings.map((element) => [
              element.getAttribute("aria-label"),
              element.getAnimations()[0]?.playState,
            ]),
          );
        expect(await ringState()).toEqual([[label, playState]]);
        const namedLink = (name: string) => row.getByRole("link", { name, exact: true });
        expect(await namedLink(`${label} Queued repair`).count()).toBe(1);
        await support.captureUiProof(suite, page, `${status}-session-ring.png`);

        const listRequests = (await gateway.getRequests("sessions.list")).length;
        await gateway.setSessionsListResponse(
          support.sessionsListResponse([
            sessionRow(mainKey, "Main", 2),
            workRow("running", { unread: true }),
          ]),
        );
        await gateway.emitGatewayEvent("sessions.changed", {
          hasActiveRun: true,
          key: queuedKey,
          reason: "agent.run.started",
          status: "running",
        });
        await expect
          .poll(() => ui.requestCount(gateway, "sessions.list"))
          .toBeGreaterThan(listRequests);
        const link = row.locator(".sidebar-recent-session__link");
        await expect
          .poll(() =>
            link.evaluate((element) => {
              const id = element.getAttribute("aria-describedby");
              return id ? element.ownerDocument.getElementById(id)?.textContent : null;
            }),
          )
          .toBe("Unread");
        expect(await row.locator(".session-row-state").count()).toBe(0);
        expect(await row.getByRole("img", { name: "Unread", exact: true }).count()).toBe(0);
        const accessibility = await page.context().newCDPSession(page);
        const { nodes } = await accessibility.send("Accessibility.getFullAXTree");
        const linkNode = nodes.find(
          (node) => node.role?.value === "link" && node.name?.value === "Active run Queued repair",
        );
        expect(linkNode?.description?.value).toBe("Unread");
        await accessibility.detach();
        expect(await namedLink("Active run Queued repair").count()).toBe(1);
        expect(await row.locator(".sidebar-recent-session__subtitle").count()).toBe(0);
        expect(await ringState()).toEqual([["Active run", "running"]]);
        await support.captureUiProof(suite, page, `${status}-session-running.png`);
      },
      { colorScheme: "dark" },
      `${status}-session-ring.webm`,
    ),
  ),
);
