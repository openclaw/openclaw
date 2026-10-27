import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { openChatDetailsPeople } from "./chat-details.test-support.ts";
import { chatSessionListResponse } from "./chat-flow.test-support.ts";
import { board } from "./chat-layout-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI chat header owner presence capture",
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:chat:aabbccdd-1234-4321-9876-123456789abc";
const identity = (name: string): { type: "profile"; id: string } => ({
  type: "profile",
  id: `profile-${name.toLowerCase()}`,
});
const actor = (label: string) => ({
  type: "human",
  id: identity(label).id,
  identity: identity(label),
  label,
});
const watcher = (name: string, self = false) => ({
  id: identity(name).id,
  identity: identity(name),
  name,
  ...(self ? { self } : { watchedSessions: [sessionKey] }),
});
const ada = actor("Ada");

suite.define(() => {
  it.each(["chat", "dashboard"] as const)(
    "deduplicates participants watching the %s",
    async (face) => {
      const outputDir = createControlUiE2eArtifactDir(
        "chat-header-owner-presence",
        process.env.OPENCLAW_CHAT_HEADER_CAPTURE_OUTPUT_DIR,
      );
      await suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 760, width: 1180 },
        },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            hasMultipleSessionSharingIdentities: true,
            authMethod: "trusted-proxy",
            authMode: "trusted-proxy",
            presenceUsers: [
              watcher("Operator", true),
              ...["Ada", "Zoe", "Lin", "Sam", "Kai"].map((name) => watcher(name)),
            ],
            emitPresenceOnConnect: false,
            sessionKey,
            deferredMethods: ["connect"],
            historyMessages: [{ role: "assistant", content: "Synthetic cached conversation." }],
            featureMethods: [
              "board.get",
              "session.members.listEvidence",
              "session.members.add",
              "session.members.remove",
              "session.visibility.set",
              "session.publicShare.set",
            ],
            methodResponses: {
              "board.get": board(sessionKey),
              "sessions.list": {
                ...chatSessionListResponse([
                  createControlUiSessionRow(
                    sessionKey,
                    "Owner presence",
                    Date.parse("2026-08-14T12:00:00.000Z"),
                    {
                      createdActor: ada,
                      owner: { actor: ada },
                      participants: [{ identity: identity("Zoe"), label: "Zoe" }],
                      participantCount: 1,
                      sharingRole: "owner",
                      visibility: "shared",
                    },
                  ),
                ]),
                owners: [ada, actor("Zoe")],
                ts: Date.parse("2026-08-14T12:00:00.000Z"),
              },
            },
          });

          const response = await page.goto(
            controlUiSessionUrl(suite.server.baseUrl, sessionKey, face),
          );
          expect(response?.status()).toBe(200);
          await gateway.waitForRequest("connect");
          await gateway.resolveDeferred("connect");
          await waitForControlUiGatewayReady(page);
          const hello = await evaluateControlUiContext(
            page,
            (context) => context.gateway.snapshot.hello,
          );
          expect(hello).not.toBeNull();
          await gateway.emitGatewayEvent("presence", { presence: hello?.snapshot?.presence });
          const header = page.locator(".chat-pane__header").first();
          const count = (selector: string, expected: number) =>
            expect.poll(() => header.locator(selector).count()).toBe(expected);
          const attribute = (selector: string, name: string) =>
            expect.poll(() => header.locator(selector).getAttribute(name));
          await header.waitFor({ state: "visible" });
          for (const id of ["profile-ada", "profile-kai", "profile-lin"]) {
            await count(`[data-viewer-id="${id}"]`, 1);
          }
          await attribute(".chat-pane__presence .viewer-facepile", "data-viewer-count").toBe("5");
          await header.locator("button.chat-pane__sharing-trigger").waitFor({ state: "visible" });

          await page.getByText("Synthetic cached conversation.", { exact: true }).waitFor();
          await page.evaluate(async () => {
            const pane = document.querySelector(".chat-pane-cache__pane--active");
            await Reflect.get(pane!, "sessionSnapshotStore").flush();
          });
          await page.addInitScript(() => {
            const inspect = () => {
              const header = document.querySelector(".chat-pane__header");
              if (!header?.getBoundingClientRect().height) {
                requestAnimationFrame(inspect);
                return;
              }
              Reflect.set(
                window,
                "firstHeaderViewerCount",
                header
                  .querySelector(".chat-pane__presence .viewer-facepile")
                  ?.getAttribute("data-viewer-count") ?? null,
              );
            };
            requestAnimationFrame(inspect);
          });
          await page.reload();
          await gateway.waitForRequest("connect");
          await page.getByText("Synthetic cached conversation.", { exact: true }).waitFor();
          expect(await page.evaluate(() => Reflect.get(window, "firstHeaderViewerCount"))).toBe(
            "5",
          );
          expect(await header.locator(".chat-pane__presence .viewer-facepile").count()).toBe(1);
          expect(
            await header
              .locator(".chat-pane__presence .viewer-facepile")
              .getAttribute("data-viewer-count"),
          ).toBe("5");
          expect(await header.locator(".viewer-avatar--overflow").textContent()).toBe("+2");
          const placeholder = header.locator("[inert] .chat-pane__sharing-trigger");
          await placeholder.waitFor({ state: "visible" });
          const cachedSharingBox = await placeholder.boundingBox();
          const cachedPeopleBox = await header.locator(".chat-pane__presence").boundingBox();
          const membershipReads = await gateway.getRequests("session.members.listEvidence");
          await placeholder.click({ force: true });
          expect(await header.locator(".chat-pane__sharing-panel:visible").count()).toBe(0);
          expect(await gateway.getRequests("session.members.listEvidence")).toHaveLength(
            membershipReads.length,
          );
          const cachedAvatar = await header
            .locator('[data-viewer-id="profile-ada"]')
            .elementHandle();
          await header.screenshot({
            animations: "disabled",
            path: path.join(outputDir, `${face}-warm-header.png`),
          });
          await gateway.resolveDeferred("connect", {
            ...hello,
            snapshot: {
              ...hello?.snapshot,
              presence: hello?.snapshot?.presence?.filter(
                (row) => row.user?.id === "profile-operator",
              ),
            },
          });
          await waitForControlUiGatewayReady(page);
          await attribute(".chat-pane__presence .viewer-facepile", "data-viewer-count").toBe("5");
          expect(await cachedAvatar?.evaluate((element) => element.isConnected)).toBe(true);
          const liveSharingBox = await header
            .locator("button.chat-pane__sharing-trigger")
            .boundingBox();
          expect(liveSharingBox).toEqual(cachedSharingBox);
          expect(await header.locator(".chat-pane__presence").boundingBox()).toEqual(
            cachedPeopleBox,
          );
          await gateway.emitGatewayEvent("presence", { presence: hello?.snapshot?.presence });
          await attribute(".chat-pane__presence .viewer-facepile", "data-viewer-count").toBe("5");
          expect(await cachedAvatar?.evaluate((element) => element.isConnected)).toBe(true);

          const screenshotPath = path.join(outputDir, `${face}-header.png`);
          const clip = await header.boundingBox();
          if (!clip) {
            throw new Error("Chat header did not expose a screenshot bounding box");
          }
          await page.screenshot({ animations: "disabled", clip, path: screenshotPath });
          process.stdout.write(`Chat header screenshot: ${screenshotPath}\n`);

          const people = await openChatDetailsPeople(page);
          const members = people.locator(".chat-details-people__person");
          const owner = members.filter({ hasText: "Ada" });
          const participant = members.filter({ hasText: "Zoe" });
          await owner.waitFor({ state: "visible" });
          await participant.waitFor({ state: "visible" });
          expect(await members.count()).toBe(2);
          expect(await owner.locator(".chat-details-people__role").textContent()).toBe("Owner");

          await gateway.emitGatewayEvent("presence", { presence: [] });
          await count(".chat-pane__presence", 0);
          expect(await members.count()).toBe(2);
          expect(await owner.isVisible()).toBe(true);
          expect(await participant.isVisible()).toBe(true);
          await gateway.emitGatewayEvent("presence", {
            presence: [
              {
                ts: 1,
                user: { id: "new-viewer", name: "New viewer" },
                watchedSessions: [sessionKey],
              },
            ],
          });
          await count('[data-viewer-id="new-viewer"]', 1);
          await attribute(".chat-pane__presence .viewer-facepile", "data-viewer-count").toBe("1");
        },
      );
    },
  );
});
