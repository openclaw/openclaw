import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Cached composer display reconciliation" });

suite.define(() => {
  it("keeps cached composer controls visually settled without accepting input before live settings", async () => {
    await suite.withPage(
      { viewport: { width: 1719, height: 1000 }, serviceWorkers: "block" },
      async ({ page }) => {
        const sessionKey = "agent:main:chat:aabbccdd-1234-4321-9876-123456789abc";
        const text = "The synthetic conversation stays in place while its settings refresh.";
        const cached = createControlUiSessionRow(sessionKey, "Cached composer example", 1, {
          model: "reasoning-example",
          modelProvider: "example",
          modelOverrideSource: "user",
          thinkingLevel: "high",
          permissionMode: "full",
          totalTokens: 14_000,
          contextTokens: 100_000,
          totalTokensFresh: true,
        });
        const thinkingLevels = [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
        ];
        const gateway = await installMockGateway(page, {
          sessionKey,
          authMethod: "trusted-proxy",
          authMode: "trusted-proxy",
          deferredMethods: ["connect"],
          agentModel: "example/reasoning-example",
          sessions: [cached],
          historyMessages: [{ role: "assistant", content: text }],
          models: [
            {
              id: "reasoning-example",
              name: "Reasoning example",
              provider: "example",
              reasoning: true,
              thinkingDefault: "medium",
              thinkingLevels,
            },
            {
              id: "alternate-example",
              name: "Alternate example",
              provider: "example",
              reasoning: true,
              thinkingDefault: "medium",
              thinkingLevels,
            },
          ],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await gateway.waitForRequest("connect");
        await gateway.resolveDeferred("connect");
        await page.getByText(text, { exact: true }).waitFor();
        const pane = page.locator(".chat-pane-cache__pane--active");
        const composer = pane.locator(".agent-chat__input");
        const model = composer.locator("[data-chat-model-select]");
        const effort = composer.locator("[data-chat-thinking-select]");
        const permission = composer.locator("[data-chat-permission-select]");
        const ring = pane.locator(".context-ring");
        const flushSnapshot = () =>
          page.evaluate(async () => {
            const active = document.querySelector(".chat-pane-cache__pane--active");
            await Reflect.get(active!, "sessionSnapshotStore").flush();
          });
        await expect.poll(() => model.getAttribute("aria-disabled")).toBe("false");
        await expect
          .poll(() => model.getAttribute("data-chat-select-value"))
          .toBe("example/reasoning-example");
        await expect.poll(() => effort.getAttribute("data-chat-thinking-value")).toBe("high");
        await expect.poll(() => permission.getAttribute("data-chat-select-value")).toBe("full");
        await flushSnapshot();

        const appearance = () =>
          pane
            .locator(
              "[data-chat-model-select], [data-chat-thinking-select], [data-chat-permission-select]",
            )
            .evaluateAll((controls) =>
              controls.map((control) => {
                const style = getComputedStyle(control);
                return {
                  class: control.className,
                  opacity: style.opacity,
                  color: style.color,
                  cursor: style.cursor,
                };
              }),
            );
        const liveAppearance = await appearance();
        await expect.poll(() => ring.getAttribute("aria-label")).toContain("14%");
        await page.addInitScript(() => {
          const sample = () => {
            if (document.querySelector(".agent-chat__input")) {
              const sampledRing = document.querySelector(".context-ring");
              Reflect.set(window, "firstComposerContext", {
                label: sampledRing?.getAttribute("aria-label"),
                opacity: sampledRing ? getComputedStyle(sampledRing).opacity : null,
              });
            } else {
              requestAnimationFrame(sample);
            }
          };
          requestAnimationFrame(sample);
        });
        await page.reload();
        await gateway.waitForRequest("connect");
        await page.getByText(text, { exact: true }).waitFor();
        expect(await appearance()).toEqual(liveAppearance);
        expect(
          await page.evaluate(async () => {
            await new Promise(requestAnimationFrame);
            return Reflect.get(window, "firstComposerContext");
          }),
        ).toEqual({
          label: "Session context usage: 14k of 100k (14%)",
          opacity: "1",
        });
        expect(await ring.getAttribute("aria-label")).toContain("14%");
        for (const control of [model, effort, permission]) {
          expect(await control.getAttribute("aria-disabled")).toBe("true");
          expect(await control.getAttribute("aria-description")).toContain("Refreshing");
          await control.click({ force: true });
          await control.press("Enter");
          await control.press("Space");
        }
        // Disabled controls can explain refresh state in a tooltip without opening a picker.
        expect(
          await composer.locator('details[open], :popover-open:not([role="tooltip"])').count(),
        ).toBe(0);
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
        await gateway.resolveDeferred("connect");
        await expect.poll(() => permission.isEnabled()).toBe(true);
        expect(await appearance()).toEqual(liveAppearance);
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);

        const live = {
          ...cached,
          updatedAt: 2,
          model: "alternate-example",
          thinkingLevel: "low",
          permissionMode: "workspace",
          totalTokens: 42_000,
        };
        await gateway.setSessionsListResponse({ sessions: [live] });
        await gateway.setMethodResponse("sessions.describe", { session: live });
        await page.reload();
        await gateway.waitForRequest("connect");
        await page.getByText(text, { exact: true }).waitFor();
        await expect.poll(() => effort.getAttribute("data-chat-thinking-value")).toBe("high");
        expect(await model.textContent()).toContain("Reasoning example");
        expect(await model.getAttribute("aria-busy")).toBe("false");
        expect(await model.getAttribute("aria-disabled")).toBe("true");
        expect(await effort.getAttribute("aria-disabled")).toBe("true");
        expect(await permission.getAttribute("data-chat-select-value")).toBe("full");
        expect(await permission.isDisabled()).toBe(true);
        expect(await ring.getAttribute("aria-label")).toContain("14%");
        const retainedRing = await ring.elementHandle();
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);

        await gateway.resolveDeferred("connect");
        await expect
          .poll(() => model.getAttribute("data-chat-select-value"))
          .toBe("example/alternate-example");
        await expect.poll(() => effort.getAttribute("data-chat-thinking-value")).toBe("low");
        await expect
          .poll(() => permission.getAttribute("data-chat-select-value"))
          .toBe("workspace");
        await expect.poll(() => permission.isEnabled()).toBe(true);
        await expect.poll(() => ring.getAttribute("aria-label")).toContain("42%");
        expect(
          await retainedRing!.evaluate(
            (element) => element === document.querySelector(".context-ring"),
          ),
        ).toBe(true);
        await flushSnapshot();

        const cleared = {
          ...cached,
          updatedAt: 3,
          modelOverrideSource: null,
          thinkingLevel: undefined,
          permissionMode: undefined,
        };
        await gateway.setSessionsListResponse({ sessions: [cleared] });
        await gateway.setMethodResponse("sessions.describe", { session: cleared });
        await page.reload();
        await gateway.waitForRequest("connect");
        await page.getByText(text, { exact: true }).waitFor();
        await expect.poll(() => effort.getAttribute("data-chat-thinking-value")).toBe("low");
        expect(await permission.getAttribute("data-chat-select-value")).toBe("workspace");
        expect(await permission.isDisabled()).toBe(true);
        await gateway.resolveDeferred("connect");
        await expect.poll(() => model.textContent()).toContain("Reasoning example");
        await expect.poll(() => effort.getAttribute("data-chat-thinking-value")).toBe("");
        await expect.poll(() => effort.textContent()).toContain("Medium");
        await expect.poll(() => permission.getAttribute("data-chat-select-value")).toBe("");
        await expect.poll(() => permission.isEnabled()).toBe(true);
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      },
    );
  });
});
