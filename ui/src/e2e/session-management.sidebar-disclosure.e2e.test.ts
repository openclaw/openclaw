import { buildControlUiSessionPath } from "@openclaw/session-url-contract";
import { expect, it } from "vitest";
import { pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import * as ui from "./session-management.compact.test-support.ts";
import * as support from "./session-management.test-support.ts";

const suite = support.createSessionManagementE2eSuite();
const parentKey = "agent:main:loop-parent";
const peerKey = "agent:main:loop-peer";
const firstKey = "agent:main:loop-child";
const nextKey = "agent:main:loop-next-child";
const baseTime = Date.parse("2026-11-01T12:00:00Z");
const childScope = { spawnedBy: parentKey };
const parent = sessionRow(parentKey, "Release loop", baseTime, { childSessions: [firstKey] });
const peer = sessionRow(peerKey, "Review loop", baseTime - 1_000);
const child = sessionRow(firstKey, "Check release notes", baseTime - 2_000, childScope);
const nextChild = sessionRow(nextKey, "Check package metadata", baseTime - 3_000, childScope);

suite.define(() => {
  it.each(["literal", "short collision", "home", "legacy"] as const)(
    "does not restore the previous chat's auto-opened branch for a different chat (%s)",
    (kind) =>
      ui.withSessionPage(
        suite,
        async (page) => {
          const uuid = "52c864fe-5ba2-4eb4-9e9e-2dfa26a21dda";
          const savedKey =
            kind === "short collision"
              ? "agent:main:chat:52c864fe-1111-4eb4-9e9e-2dfa26a21dda"
              : firstKey;
          const savedChild = sessionRow(savedKey, "Check release notes", baseTime, childScope);
          const savedParent = sessionRow(parentKey, "Release loop", baseTime, {
            childSessions: [savedKey],
          });
          const gateway = await support.installMockGateway(page, {
            sessionKey: savedKey,
            sessions: [savedParent, savedChild],
            heldMethods: ["connect"],
            authMethod: "token",
            authMode: "token",
            presenceUsers: [
              { id: "profile-a", self: true, identity: { type: "profile", id: "profile-a" } },
            ],
            methodResponses: {
              "sessions.list": {
                cases: [
                  { match: childScope, response: support.sessionsListResponse([savedChild]) },
                  { response: support.sessionsListResponse([savedParent]) },
                ],
              },
            },
          });
          const sidebar = page.locator("aside.sidebar");
          const toggle = sidebar.locator(`[data-child-session-toggle="${parentKey}"]`);
          const childRow = ui.sessionRows(sidebar)(savedKey);
          await page.goto(
            support.controlUiSessionUrl(suite.server.baseUrl, savedKey) + "#token=test-token",
          );
          await gateway.waitForRequest("connect");
          await gateway.resolveDeferred("connect");
          await childRow.waitFor();
          await sidebar.and(page.locator('[data-snapshot-saved="true"]')).waitFor();

          await page.goto(
            support
              .controlUiSessionUrl(suite.server.baseUrl, savedKey)
              .replace("loop-child", "LOOP-CHILD"),
          );
          await gateway.waitForRequest("connect");
          await sidebar.and(page.locator('[data-snapshot-state="cached"]')).waitFor();
          await childRow.waitFor();
          await gateway.resolveDeferred("connect");
          await sidebar.and(page.locator('[data-snapshot-state="live"]')).waitFor();

          await page.addInitScript((observedParent) => {
            const seen = new Set<string>();
            Reflect.set(globalThis, "cachedSidebarDisclosureStates", seen);
            new MutationObserver(() => {
              const cachedToggle = document.querySelector(
                `aside[data-snapshot-state="cached"] [data-child-session-toggle="${observedParent}"]`,
              );
              const expanded = cachedToggle?.getAttribute("aria-expanded");
              if (expanded) {
                seen.add(expanded);
              }
            }).observe(document, {
              childList: true,
              subtree: true,
              attributes: true,
              attributeFilter: ["aria-expanded", "data-snapshot-state"],
            });
          }, parentKey);
          const destination =
            kind === "short collision"
              ? sessionRow(`agent:main:chat:${uuid}`, "Review loop", baseTime)
              : peer;
          const destinationPath =
            kind === "home"
              ? "/chat/main"
              : kind === "legacy"
                ? `/chat?session=${encodeURIComponent(peerKey)}`
                : buildControlUiSessionPath({
                    namespace: "chat",
                    sessionKey: destination.key,
                    fallbackAgentId: "main",
                    displayName: destination.displayName,
                  });
          expect(destinationPath).not.toBeNull();
          await page.goto(new URL(destinationPath!, suite.server.baseUrl).href);
          await gateway.waitForRequest("connect");
          if (kind !== "legacy") {
            await sidebar.and(page.locator('[data-snapshot-state="cached"]')).waitFor();
            await toggle.waitFor();
            expect(
              await page.evaluate(() =>
                Array.from(Reflect.get(globalThis, "cachedSidebarDisclosureStates")),
              ),
            ).toEqual(["false"]);
            await support.captureUiProof(suite, page, "sidebar-disclosure-reload.png");
            expect(await toggle.getAttribute("aria-expanded")).toBe("false");
            expect(await childRow.count()).toBe(0);
          }
          if (kind === "literal" || kind === "short collision") {
            await gateway.deferNext("sessions.resolve");
          } else if (kind === "legacy") {
            await gateway.setMethodResponse("sessions.resolve", { ok: true, ...destination });
          }
          await gateway.resolveDeferred("connect");
          if (kind === "literal" || kind === "short collision") {
            const resolution = await gateway.waitForRequest("sessions.resolve");
            expect(resolution.params).toMatchObject(
              kind === "literal"
                ? { reference: { key: peerKey } }
                : { shortId: uuid.slice(0, 8), slugHint: "review-loop" },
            );
            expect(await toggle.getAttribute("aria-expanded")).toBe("false");
            expect(await childRow.count()).toBe(0);
            await gateway.resolveDeferred("sessions.resolve", { ok: true, ...destination });
          }
          await page.waitForFunction(
            (key) => window.openclawControlUi?.snapshot().sessionKey === key,
            kind === "home" ? "agent:main:main" : destination.key,
          );
          await sidebar.and(page.locator('[data-snapshot-state="live"]')).waitFor();
          expect(await toggle.getAttribute("aria-expanded")).toBe("false");
          expect(
            await page.evaluate(() =>
              Array.from(Reflect.get(globalThis, "cachedSidebarDisclosureStates")),
            ),
          ).not.toContain("true");
        },
        { colorScheme: "dark", serviceWorkers: "block" },
      ),
  );

  it("keeps a background parent collapsed when its child list changes", () =>
    ui.withSessionPage(
      suite,
      async (page) => {
        const gateway = await support.installMockGateway(page, {
          sessionKey: peerKey,
          sessions: [parent, peer, child, nextChild],
          methodResponses: {
            "sessions.list": {
              cases: [
                { match: childScope, response: support.sessionsListResponse([child]) },
                { response: support.sessionsListResponse([parent, peer]) },
              ],
            },
          },
        });
        await page.goto(support.controlUiSessionUrl(suite.server.baseUrl, peerKey));
        const toggle = page.locator(`[data-child-session-toggle="${parentKey}"]`);
        const rows = ui.sessionRows(page);
        await toggle.click();
        await rows(firstKey).waitFor({ state: "visible" });
        await toggle.click();
        await rows(firstKey).waitFor({ state: "hidden" });

        await page.clock.install();
        await pauseVirtualClock(page);
        await gateway.setMethodResponse("sessions.list", {
          cases: [
            { match: childScope, response: support.sessionsListResponse([child, nextChild]) },
            {
              response: support.sessionsListResponse([
                { ...parent, childSessions: [firstKey, nextKey] },
                peer,
              ]),
            },
          ],
        });
        await gateway.emitGatewayEvent("sessions.changed", {
          reason: "create",
          sessionKey: nextKey,
          ...childScope,
        });
        await page.clock.runFor(5_001);
        await page.clock.resume();
        await expect.poll(() => toggle.getAttribute("aria-label")).toMatch(/2 child sessions/);
        await support.captureUiProof(suite, page, "child-disclosure-after-event.png");
        expect(await toggle.getAttribute("aria-expanded")).toBe("false");
        expect(await rows(firstKey).count()).toBe(0);
        await toggle.click();
        await rows(nextKey).waitFor({ state: "visible" });
      },
      { colorScheme: "dark" },
    ));
});
