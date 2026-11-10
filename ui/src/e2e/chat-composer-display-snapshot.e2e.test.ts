import { expect, it } from "vitest";
import type { AppSidebarElement } from "../components/app-sidebar.tsx";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
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
          modelProvider: "openai",
          modelOverrideSource: "user",
          thinkingLevel: "high",
          fastMode: true,
          effectiveFastMode: true,
          status: "running",
          hasActiveRun: true,
          activeRunIds: ["synthetic-active-run"],
          lastRunId: "synthetic-active-run",
          permissionMode: undefined,
          totalTokens: 14_000,
          contextTokens: 100_000,
          totalTokensFresh: true,
          contextWindow: "large",
          contextWindowDefault: "standard",
          contextWindows: [
            { id: "standard", label: "Standard", contextWindow: 100_000 },
            { id: "large", label: "Large", contextWindow: 200_000 },
          ],
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
          deferredMethods: ["connect", "sessions.describe", "sessions.list", "agents.list"],
          agentModel: "openai/reasoning-example",
          sessions: [cached],
          historyMessages: [{ role: "assistant", content: text }],
          models: [
            {
              id: "reasoning-example",
              name: "Reasoning example",
              provider: "openai",
              reasoning: true,
              thinkingDefault: "medium",
              thinkingLevels,
            },
            {
              id: "alternate-example",
              name: "Alternate example",
              provider: "openai",
              reasoning: true,
              thinkingDefault: "medium",
              thinkingLevels,
            },
          ],
        });
        const setAgentDefault = (defaultPermissionMode?: "full" | "guarded") =>
          gateway.setMethodResponse("agents.list", {
            agents: [
              { id: "main", model: { primary: "openai/reasoning-example" }, defaultPermissionMode },
            ],
            defaultId: "main",
            mainKey: "main",
            scope: "per-sender",
          });
        const releaseAgents = async () => {
          await gateway.waitForRequest("agents.list");
          await gateway.resolveDeferred("agents.list");
        };
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await setAgentDefault("full");
        await gateway.waitForRequest("connect");
        await gateway.resolveDeferred("connect");
        const releaseSessionRow = async () => {
          await gateway.waitForRequest("sessions.describe");
          await gateway.resolveDeferred("sessions.describe");
        };
        await releaseAgents();
        await releaseSessionRow();
        await gateway.waitForRequest("sessions.list");
        await gateway.resolveDeferred("sessions.list");
        await page.getByText(text, { exact: true }).waitFor();
        const pane = page.locator(".chat-pane-cache__pane--active");
        const model = pane.locator("[data-chat-model-select]");
        const effort = pane.locator("[data-chat-thinking-select]");
        const permission = pane.locator("[data-chat-permission-select]");
        const ring = pane.locator(".context-ring");
        const stop = pane.getByRole("button", { name: "Stop", exact: true });
        const stopAppearance = () =>
          stop.evaluate((element) => {
            const style = getComputedStyle(element);
            return [style.color, style.backgroundColor, style.opacity];
          });
        const flushSnapshot = () =>
          page.evaluate(async () => {
            const active = document.querySelector(".chat-pane-cache__pane--active");
            await Reflect.get(active!, "sessionSnapshotStore").flush();
          });
        await expect.poll(() => model.getAttribute("aria-disabled")).toBe("false");
        await expect
          .poll(() => model.getAttribute("data-chat-select-value"))
          .toBe("openai/reasoning-example");
        await expect.poll(() => effort.getAttribute("data-chat-thinking-value")).toBe("high");
        await expect.poll(() => permission.getAttribute("data-chat-select-value")).toBe("");
        await expect.poll(() => permission.textContent()).toContain("Full access");
        await openChatDetails(page);
        await flushSnapshot();
        await page.locator('aside.sidebar[data-snapshot-saved="true"]').waitFor();
        expect(
          await page
            .locator("openclaw-app-sidebar")
            .evaluate((element: AppSidebarElement) => element.snapshotCaptureStatus()),
        ).toBe("saved");

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
        const liveStopAppearance = await stopAppearance();
        await expect.poll(() => ring.getAttribute("aria-label")).toContain("14%");
        await page.addInitScript(() => {
          const frames: {
            at: number;
            controls: { selector: string; x: number; width: number; text: string }[];
          }[] = [];
          Reflect.set(window, "composerControlFrames", frames);
          let previous = "";
          const sample = () => {
            const selectors = [
              ".agent-chat__composer-trail",
              ".agent-chat__composer-controls",
              ".context-usage",
              "[data-chat-model-select]",
              "[data-chat-thinking-select]",
              "[data-chat-permission-select]",
              ".agent-chat__composer-actions",
            ];
            const controls = selectors.flatMap((selector) => {
              const element = document.querySelector(selector);
              const box = element?.getBoundingClientRect();
              return element && box?.width
                ? [
                    {
                      selector,
                      x: box.x,
                      width: box.width,
                      text: element.textContent?.trim() ?? "",
                    },
                  ]
                : [];
            });
            const signature = JSON.stringify(controls);
            if (controls.length && signature !== previous) {
              frames.push({ at: performance.now(), controls });
              previous = signature;
            }
            if (document.querySelector(".agent-chat__input")) {
              const sampledRing = document.querySelector(".context-ring");
              if (!Reflect.has(window, "firstComposerContext")) {
                Reflect.set(window, "firstComposerContext", {
                  label: sampledRing?.getAttribute("aria-label"),
                  opacity: sampledRing ? getComputedStyle(sampledRing).opacity : null,
                });
              }
            }
            if (!Reflect.get(window, "composerControlFramesStopped")) {
              requestAnimationFrame(sample);
            }
          };
          requestAnimationFrame(sample);
        });
        await page.reload();
        await gateway.waitForRequest("connect");
        await page.getByText(text, { exact: true }).waitFor();
        expect(
          await pane.evaluate(
            (element) => Reflect.get(element, "state").sessions.state.resultCached,
          ),
        ).toBe(true);
        await pane
          .locator(".agent-chat__input")
          .screenshot({ path: `${suite.artifactDir}/cached-composer.png` });
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
        expect(await stopAppearance()).toEqual(liveStopAppearance);
        expect(await stop.isDisabled()).toBe(true);
        await stop.click({ force: true });
        expect(await gateway.getRequests("sessions.abort")).toHaveLength(0);
        for (const control of [model, effort, permission]) {
          expect(await control.getAttribute("aria-disabled")).toBe("true");
          expect(await control.getAttribute("aria-description")).toContain("Refreshing");
          await control.click({ force: true });
          await control.press("Enter");
          await control.press("Space");
        }
        expect(await pane.locator("details[open], :popover-open").count()).toBe(0);
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
        const freshHistory = "Live history arrived before the session row.";
        await gateway.setMethodResponse("chat.startup", {
          sessionId: cached.sessionId,
          messages: [
            { role: "assistant", content: text },
            { role: "assistant", content: freshHistory },
          ],
        });
        await gateway.resolveDeferred("connect");
        await pane.locator("p").getByText(freshHistory, { exact: true }).waitFor();
        expect(await permission.getAttribute("data-chat-select-value")).toBe("");
        expect(await permission.isDisabled()).toBe(true);
        await releaseSessionRow();
        await expect.poll(() => permission.isEnabled()).toBe(true);
        await expect.poll(() => model.getAttribute("aria-disabled")).toBe("false");
        expect(await stop.isEnabled()).toBe(true);
        expect(await permission.textContent()).toContain("Full access");
        const pendingPermissionBox = await permission.boundingBox();
        await releaseAgents();
        await expect.poll(() => permission.textContent()).toContain("Full access");
        expect(await permission.boundingBox()).toEqual(pendingPermissionBox);
        await flushSnapshot();
        await pane
          .locator(".agent-chat__input")
          .screenshot({ path: `${suite.artifactDir}/live-composer.png` });
        const frames = await page.evaluate(async () => {
          await new Promise(requestAnimationFrame);
          Reflect.set(window, "composerControlFramesStopped", true);
          return Reflect.get(window, "composerControlFrames");
        });
        for (const frame of frames) {
          expect(frame.controls).toHaveLength(frames[0].controls.length);
          for (const [index, control] of frame.controls.entries()) {
            expect(
              Math.abs(control.x - frames[0].controls[index].x),
              control.selector,
            ).toBeLessThanOrEqual(1);
            expect(
              Math.abs(control.width - frames[0].controls[index].width),
              control.selector,
            ).toBeLessThanOrEqual(1);
            expect(control.text, control.selector).toBe(frames[0].controls[index].text);
          }
        }
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
        await setAgentDefault("guarded");
        await gateway.setSessionsListResponse({ sessions: [live] });
        await gateway.setMethodResponse("sessions.describe", { session: live });
        await gateway.setMethodResponse("chat.startup", {
          sessionId: live.sessionId,
          sessionInfo: live,
          messages: [{ role: "assistant", content: text }],
        });
        await page.reload();
        await gateway.waitForRequest("connect");
        await page.getByText(text, { exact: true }).waitFor();
        await expect.poll(() => effort.getAttribute("data-chat-thinking-value")).toBe("high");
        expect(await model.textContent()).toContain("Reasoning example");
        expect(await model.getAttribute("aria-busy")).toBe("false");
        expect(await model.getAttribute("aria-disabled")).toBe("true");
        expect(await effort.getAttribute("aria-disabled")).toBe("true");
        expect(await permission.getAttribute("data-chat-select-value")).toBe("");
        expect(await permission.isDisabled()).toBe(true);
        expect(await ring.getAttribute("aria-label")).toContain("14%");
        const retainedRing = await ring.elementHandle();
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);

        await gateway.resolveDeferred("connect");
        await releaseSessionRow();
        await expect
          .poll(() => model.getAttribute("data-chat-select-value"))
          .toBe("openai/alternate-example");
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
        await releaseAgents();
        expect(await permission.getAttribute("data-chat-select-value")).toBe("workspace");
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
        await gateway.setMethodResponse("chat.startup", {
          sessionId: cleared.sessionId,
          sessionInfo: cleared,
          messages: [{ role: "assistant", content: text }],
        });
        await page.reload();
        await gateway.waitForRequest("connect");
        await page.getByText(text, { exact: true }).waitFor();
        await expect.poll(() => effort.getAttribute("data-chat-thinking-value")).toBe("low");
        expect(await permission.getAttribute("data-chat-select-value")).toBe("workspace");
        expect(await permission.isDisabled()).toBe(true);
        await gateway.resolveDeferred("connect");
        await releaseSessionRow();
        await expect.poll(() => model.textContent()).toContain("Reasoning example");
        await expect.poll(() => effort.getAttribute("data-chat-thinking-value")).toBe("");
        await expect.poll(() => effort.textContent()).toContain("Medium");
        await expect.poll(() => permission.getAttribute("data-chat-select-value")).toBe("");
        await expect.poll(() => permission.isEnabled()).toBe(true);
        await expect.poll(() => permission.textContent()).toContain("Ask me");
        await releaseAgents();
        await flushSnapshot();
        for (const [next, previousLabel, nextLabel] of [
          ["full", "Ask me", "Full access"],
          [undefined, "Full access", "Default"],
        ] as const) {
          await setAgentDefault(next);
          await page.reload();
          await gateway.waitForRequest("connect");
          await page.getByText(text, { exact: true }).waitFor();
          await expect.poll(() => permission.textContent()).toContain(previousLabel);
          const retainedPermission = await permission.elementHandle();
          const before = await permission.boundingBox();
          await gateway.resolveDeferred("connect");
          await releaseSessionRow();
          await expect.poll(() => permission.isEnabled()).toBe(true);
          expect(await permission.textContent()).toContain(previousLabel);
          expect(await permission.boundingBox()).toEqual(before);
          await releaseAgents();
          await expect.poll(() => permission.textContent()).toContain(nextLabel);
          expect(
            await retainedPermission!.evaluate(
              (element) => element === document.querySelector("[data-chat-permission-select]"),
            ),
          ).toBe(true);
          await flushSnapshot();
        }
        await page.reload();
        await gateway.waitForRequest("connect");
        await page.getByText(text, { exact: true }).waitFor();
        expect(await permission.textContent()).toBe("Default");
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      },
    );
  });
});
