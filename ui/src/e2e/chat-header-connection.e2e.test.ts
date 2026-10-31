import path from "node:path";
import { expect, it } from "vitest";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { board } from "./chat-layout-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat header connection feedback" });
const sessionKey = "agent:main:dashboard:12345678-90ab-4def-8234-567890abcdef";
const transcript = "The observatory report is saved and ready to read.";

suite.define(() => {
  it.each(["chat", "dashboard"] as const)(
    "keeps cached %s header geometry through a slow or failed connection",
    async (face) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        await page.clock.install();
        const gateway = await installMockGateway(page, {
          sessionKey,
          awaitInitialRoster: false,
          heldMethods: ["connect"],
          authMethod: "trusted-proxy",
          authMode: "trusted-proxy",
          presenceUsers: [{ id: "fixture-operator", self: true, name: "Fixture operator" }],
          featureMethods: [...defaultControlUiFeatureMethods, "board.get"],
          methodResponses: { "board.get": board(sessionKey) },
          sessions: [
            {
              key: sessionKey,
              sessionId: "observatory",
              kind: "direct",
              label: "Observatory report",
              boardFace: "dashboard",
              updatedAt: 1,
            },
          ],
          historyMessages: [{ role: "assistant", content: transcript }],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, face));
        await gateway.waitForRequest("connect");
        await gateway.resolveDeferred("connect");
        const conversation = page.getByText(transcript, { exact: true }).first();
        await conversation.waitFor();
        await expect
          .poll(() =>
            page.evaluate(async () => {
              if (
                !(await indexedDB.databases()).some((db) => db.name === "openclaw-chat-snapshots")
              ) {
                return false;
              }
              const open = indexedDB.open("openclaw-chat-snapshots");
              const db = await new Promise<IDBDatabase>((resolve, reject) => {
                open.onsuccess = () => resolve(open.result);
                open.onerror = () => reject(open.error);
              });
              try {
                const read = db.transaction("snapshots").objectStore("snapshots").count();
                return await new Promise<boolean>((resolve, reject) => {
                  read.onsuccess = () =>
                    resolve(
                      read.result > 0 &&
                        Object.keys(localStorage).some((key) =>
                          key.startsWith("openclaw.control.bootRecord.v1:"),
                        ),
                    );
                  read.onerror = () => reject(read.error);
                });
              } finally {
                db.close();
              }
            }),
          )
          .toBe(true);
        const header = page.locator(".chat-pane-cache__pane--visible .chat-pane__header").first();
        const status = header.locator(".chat-pane__connection");
        const geometry = () =>
          header
            .locator(".chat-pane__header-trailing, .chat-pane__identity-actions")
            .evaluateAll((elements) =>
              elements.map((element) => {
                const { x, y, width, height } = element.getBoundingClientRect();
                return { x, y, width, height };
              }),
            );
        const capture = async (name: string) => {
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            await page.screenshot({ path: path.join(suite.artifactDir, `${face}-${name}.png`) });
          }
        };

        await page.reload({ waitUntil: "domcontentloaded" });
        await gateway.waitForRequest("connect");
        await conversation.waitFor();
        await capture("boot");
        expect(await status.count()).toBe(0);
        const before = await geometry();
        await page.clock.fastForward(2_000);
        await status.waitFor({ state: "visible" });
        expect(await geometry()).toEqual(before);
        expect(
          await status.evaluate((element) => {
            const indicator = element.getBoundingClientRect();
            const header = element.closest(".chat-pane__header")!.getBoundingClientRect();
            return indicator.top >= header.top && indicator.bottom <= header.bottom;
          }),
        ).toBe(true);
        await capture("slow");
        await gateway.resolveDeferred("connect");
        await status.waitFor({ state: "hidden" });
        expect(await geometry()).toEqual(before);
        await capture("connected");

        await gateway.setOnline(false);
        await status.waitFor({ state: "visible" });
        expect(await conversation.isVisible()).toBe(true);
        expect(await geometry()).toEqual(before);
        await capture("offline");
      });
    },
  );
});
