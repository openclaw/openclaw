import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  captureUiProofEnabled,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
  waitForPatch,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();
const viewport = { width: 1280, height: 900 };
const draft = "変換中";
const finalTitle = "確定した名前";

suite.define(() => {
  it.each([
    { kind: "modern", key: "Enter", isComposing: true, keyCode: 0 },
    { kind: "modern", key: "Escape", isComposing: true, keyCode: 0 },
    { kind: "legacy", key: "Enter", isComposing: false, keyCode: 229 },
    { kind: "legacy", key: "Escape", isComposing: false, keyCode: 229 },
  ] as const)(
    "keeps the rename draft during $kind composition $key until ordinary Enter",
    async ({ kind, key, isComposing, keyCode }) => {
      const proofDir = captureUiProofEnabled
        ? createControlUiE2eArtifactDir("chat-header-rename-ime")
        : undefined;
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport },
        async ({ page }) => {
          const original = sessionRow(
            "agent:main:rename-composition",
            "Original session",
            Date.parse("2026-08-27T12:00:00.000Z"),
          );
          const gateway = await installMockGateway(page, {
            methodResponses: { "sessions.list": sessionsListResponse([original]) },
            sessionKey: original.key,
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, original.key));
          const title = page.locator(".chat-pane__session-title-button");
          const sidebarRow = page.locator(
            `.sidebar-recent-session[data-session-key="${original.key}"]`,
          );
          await sidebarRow.waitFor({ state: "visible" });
          await title.click();
          const input = page.locator(".chat-pane__session-title-input");
          await expect.poll(() => input.inputValue()).toBe(original.label);
          await input.fill(draft);

          // Exercise the browser keyboard contract, not a native OS IME candidate window.
          const prevented = await input.evaluate(
            (element, args) => {
              const event = new KeyboardEvent("keydown", {
                key: args.key,
                isComposing: args.isComposing,
                keyCode: args.keyCode,
                bubbles: true,
                cancelable: true,
                composed: true,
              });
              element.dispatchEvent(event);
              return event.defaultPrevented;
            },
            { key, isComposing, keyCode },
          );

          // Retain the observed broken outcome before the unchanged RED/GREEN assertions.
          if (prevented) {
            await input.waitFor({ state: "detached" });
            if (key === "Enter") {
              await waitForPatch(gateway, (params) => params.label === draft);
              await expect.poll(() => title.textContent()).toContain(draft);
            }
          }
          const inputAttached = (await input.count()) === 1;
          const patches = await gateway.getRequests("sessions.patch");
          if (proofDir) {
            const stage = `${kind}-${key.toLowerCase()}-after-composition`;
            await writeFile(
              path.join(proofDir, `${stage}.png`),
              await takeControlUiViewportScreenshot(page, page.locator(".chat-pane__header"), [
                inputAttached ? input : title,
                sidebarRow,
              ]),
            );
            await writeFile(
              path.join(proofDir, `${stage}.json`),
              `${JSON.stringify({ prevented, inputAttached, patches }, null, 2)}\n`,
            );
          }

          expect(prevented).toBe(false);
          expect(inputAttached).toBe(true);
          expect(await input.inputValue()).toBe(draft);
          expect(patches).toEqual([]);

          await input.fill(finalTitle);
          await input.press("Enter");
          const committed = await waitForPatch(gateway, (params) => params.label === finalTitle);
          expect(committed.params).toMatchObject({
            key: original.key,
            expectedSessionId: original.sessionId,
            label: finalTitle,
          });
          expect(await gateway.getRequests("sessions.patch")).toHaveLength(1);
          await input.waitFor({ state: "detached" });
          await expect.poll(() => title.textContent()).toContain(finalTitle);
        },
      );
    },
  );

  it("cancels an ordinary Escape without persisting the rename draft", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport },
      async ({ page }) => {
        const original = sessionRow(
          "agent:main:rename-composition",
          "Original session",
          Date.parse("2026-08-27T12:00:00.000Z"),
        );
        const gateway = await installMockGateway(page, {
          methodResponses: { "sessions.list": sessionsListResponse([original]) },
          sessionKey: original.key,
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, original.key));
        const title = page.locator(".chat-pane__session-title-button");
        await title.click();
        const input = page.locator(".chat-pane__session-title-input");
        await expect.poll(() => input.inputValue()).toBe(original.label);
        await input.fill(draft);
        await input.press("Escape");
        await input.waitFor({ state: "detached" });

        expect(await gateway.getRequests("sessions.patch")).toEqual([]);
        expect(await title.textContent()).toContain(original.label);
      },
    );
  });
});
