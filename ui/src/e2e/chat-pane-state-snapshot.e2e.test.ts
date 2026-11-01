import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Cached session state presentation" });

type SessionStatePaint = {
  archived: boolean;
  readOnly: boolean;
  parent: string | null;
  height: number;
};

suite.define(() => {
  it.each(["archived", "read-only", "active", "deleted-parent"] as const)(
    "restores %s session presentation before reconnect and accepts changed live state",
    async (mode) => {
      await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
        const archived = mode === "archived" || mode === "deleted-parent";
        const parent = createControlUiSessionRow(
          "agent:main:chat:parent",
          "Previous conversation",
          1,
        );
        const session = createControlUiSessionRow(
          "agent:main:chat:archived",
          "Archived conversation",
          2,
          {
            archived,
            visibility: mode === "read-only" ? "read-only" : "shared",
            sharingRole: mode === "read-only" ? "viewer" : "owner",
            parentSessionKey: parent.key,
          },
        );
        const text = "Synthetic archived conversation content.";
        const gateway = await installMockGateway(page, {
          sessionKey: session.key,
          sessions: [parent, session],
          historyMessages: [{ role: "assistant", content: text }],
          authMethod: "trusted-proxy",
          authMode: "trusted-proxy",
          deferredMethods: ["connect"],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, session.key));
        await gateway.waitForRequest("connect");
        await gateway.resolveDeferred("connect");
        const pane = page.locator(".chat-pane-cache__pane--active");
        const unarchive = pane.getByRole("button", { name: "Unarchive", exact: true });
        const breadcrumb = pane.locator(".chat-pane__parent-session");
        const appearance = () =>
          unarchive.evaluate((button) => {
            const style = getComputedStyle(button);
            return {
              opacity: style.opacity,
              cursor: style.cursor,
              height: button.getBoundingClientRect().height,
            };
          });
        await page.getByText(text, { exact: true }).waitFor();
        await expect.poll(() => breadcrumb.textContent()).toBe(parent.displayName);
        if (archived) {
          await unarchive.waitFor();
        } else if (mode === "read-only") {
          await pane
            .getByText("Only the session owner and members can act in this session.", {
              exact: true,
            })
            .waitFor();
        } else {
          await expect.poll(() => pane.locator("textarea").isEnabled()).toBe(true);
        }
        const liveAppearance = archived ? await appearance() : undefined;
        const flushSnapshot = () =>
          page.evaluate(async () => {
            await Reflect.get(
              document.querySelector(".chat-pane-cache__pane--active")!,
              "sessionSnapshotStore",
            ).flush();
          });
        await flushSnapshot();
        if (mode === "deleted-parent") {
          await gateway.setSessionsListResponse({ sessions: [session] });
          await gateway.emitGatewayEvent("sessions.changed", {
            sessionKey: parent.key,
            agentId: "main",
            sessionId: parent.sessionId,
            reason: "delete",
          });
          await expect.poll(() => breadcrumb.count()).toBe(0);
          await flushSnapshot();
        }
        await page.addInitScript(() => {
          const frames: SessionStatePaint[] = [];
          let active = true;
          const sample = () => {
            if (!active) {
              return;
            }
            const cachedPane = document.querySelector(".chat-pane-cache__pane--active");
            const composer = cachedPane?.querySelector(".agent-chat__composer-shell");
            if (composer?.checkVisibility()) {
              frames.push({
                archived: Boolean(
                  cachedPane?.querySelector(".agent-chat__disabled-banner--replacement"),
                ),
                readOnly:
                  cachedPane?.textContent?.includes(
                    "Only the session owner and members can act in this session.",
                  ) === true,
                parent:
                  cachedPane?.querySelector(".chat-pane__parent-session")?.textContent ?? null,
                height: composer.getBoundingClientRect().height,
              });
            }
            requestAnimationFrame(sample);
          };
          Reflect.set(window, "cachedSessionStatePaints", () => {
            active = false;
            return frames;
          });
          requestAnimationFrame(sample);
        });
        await page.reload();
        await gateway.waitForRequest("connect");
        await page.getByText(text, { exact: true }).waitFor();
        // A final DOM assertion misses an earlier normal composer before cached rows.
        const paints = await page.evaluate(async () => {
          await new Promise(requestAnimationFrame);
          return Reflect.get(window, "cachedSessionStatePaints")() as SessionStatePaint[];
        });
        expect(paints.length).toBeGreaterThan(0);
        expect(paints.every((paint) => paint.archived === archived)).toBe(true);
        expect(paints.every((paint) => paint.readOnly === (mode === "read-only"))).toBe(true);
        expect(
          paints.every((paint) =>
            mode === "deleted-parent" ? paint.parent === null : paint.parent === parent.displayName,
          ),
        ).toBe(true);
        expect(new Set(paints.map((paint) => paint.height)).size).toBe(1);
        expect(await unarchive.count()).toBe(archived ? 1 : 0);
        if (mode === "read-only") {
          expect(await pane.locator("textarea").isDisabled()).toBe(true);
          expect(
            await pane
              .getByText("Only the session owner and members can act in this session.", {
                exact: true,
              })
              .count(),
          ).toBe(1);
        }
        if (mode === "deleted-parent") {
          expect(await breadcrumb.count()).toBe(0);
          await gateway.resolveDeferred("connect");
          return;
        }
        expect(await breadcrumb.textContent()).toBe(parent.displayName);
        if (archived) {
          expect(await appearance()).toEqual(liveAppearance);
          expect(await unarchive.getAttribute("aria-disabled")).toBe("true");
          await page.screenshot({ path: `${suite.artifactDir}/archived-cached.png` });
          await unarchive.click({ force: true });
          await unarchive.press("Enter");
        }
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
        const live = {
          ...session,
          archived: mode === "active",
          visibility: "shared" as const,
          sharingRole: "owner" as const,
          updatedAt: 3,
          parentSessionKey: undefined,
        };
        await gateway.setSessionsListResponse({ sessions: [live] });
        await gateway.setMethodResponse("sessions.describe", { session: live });
        await gateway.resolveDeferred("connect");
        await expect.poll(() => unarchive.count()).toBe(mode === "active" ? 1 : 0);
        await expect.poll(() => breadcrumb.count()).toBe(0);
        if (mode !== "active") {
          await expect.poll(() => pane.locator("textarea").isEnabled()).toBe(true);
        }
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      });
    },
  );
});
