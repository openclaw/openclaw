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

const session = createControlUiSessionRow(sessionKey, "Owner presence", 1, {
  createdActor: ada,
  owner: { actor: ada },
  participants: [{ identity: identity("Zoe"), label: "Zoe" }],
  participantCount: 1,
  sharingRole: "owner",
  visibility: "shared",
});

async function checkHeader(face: "chat" | "dashboard") {
  const outputDir = createControlUiE2eArtifactDir(
    "chat-header-owner-presence",
    process.env.OPENCLAW_CHAT_HEADER_CAPTURE_OUTPUT_DIR,
  );
  await suite.withPage(
    { locale: "en-US", serviceWorkers: "block", viewport: { height: 760, width: 1180 } },
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
          "session.visibility.set",
          "session.publicShare.set",
        ],
        methodResponses: {
          "board.get": board(sessionKey),
          "sessions.list": {
            ...chatSessionListResponse([session]),
            owners: [ada, actor("Zoe")],
            ts: 1,
          },
        },
      });
      expect(
        (await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, face)))?.status(),
      ).toBe(200);
      await gateway.waitForRequest("connect");
      await gateway.resolveDeferred("connect");
      await waitForControlUiGatewayReady(page);
      const hello = await evaluateControlUiContext(
        page,
        (context) => context.gateway.snapshot.hello,
      );
      await gateway.emitGatewayEvent("presence", { presence: hello?.snapshot?.presence });
      const header = page.locator(".chat-pane__header").first();
      const faces = header.locator(".chat-pane__presence .viewer-facepile");
      const sharing = header.locator(".chat-pane__sharing-trigger");
      const count = (selector: string, expected: number) =>
        expect.poll(() => header.locator(selector).count()).toBe(expected);
      const viewers = (expected: string) =>
        expect.poll(() => faces.getAttribute("data-viewer-count")).toBe(expected);
      for (const id of ["profile-ada", "profile-kai", "profile-lin"]) {
        await count(`[data-viewer-id="${id}"]`, 1);
      }
      await sharing.waitFor({ state: "visible" });
      await page.getByText("Synthetic cached conversation.", { exact: true }).waitFor();
      await page.evaluate(async () => {
        const pane = document.querySelector(".chat-pane-cache__pane--active");
        await Reflect.get(pane!, "sessionSnapshotStore").flush();
      });
      await page.addInitScript(() => {
        const observed: unknown[] = [];
        Reflect.set(window, "headerFrames", observed);
        const inspect = () => {
          const initialHeader = document.querySelector(".chat-pane__header");
          if (initialHeader?.getBoundingClientRect().height) {
            const initialFaces = initialHeader.querySelector(
              ".chat-pane__presence .viewer-facepile",
            );
            observed.push([
              initialFaces?.getAttribute("data-viewer-count") ?? null,
              initialFaces?.getBoundingClientRect().x,
            ]);
          }
          requestAnimationFrame(inspect);
        };
        requestAnimationFrame(inspect);
      });
      await page.reload();
      await gateway.waitForRequest("connect");
      await page.getByText("Synthetic cached conversation.", { exact: true }).waitFor();
      expect(await header.locator(".viewer-avatar--overflow").textContent()).toBe("+2");
      const placeholder = header.locator("[inert] .chat-pane__sharing-trigger");
      await placeholder.waitFor({ state: "visible" });
      const cachedSharingBox = await sharing.boundingBox();
      const cachedFacesBox = await faces.boundingBox();
      const membershipReads = await gateway.getRequests("session.members.listEvidence");
      await placeholder.click({ force: true });
      await count(".chat-pane__sharing-panel:visible", 0);
      expect(await gateway.getRequests("session.members.listEvidence")).toHaveLength(
        membershipReads.length,
      );
      const cachedAvatar = await header.locator('[data-viewer-id="profile-ada"]').elementHandle();
      await gateway.resolveDeferred("connect", {
        ...hello,
        snapshot: {
          ...hello?.snapshot,
          presence: hello?.snapshot?.presence?.filter((row) => row.user?.id === "profile-operator"),
        },
      });
      await waitForControlUiGatewayReady(page);
      await header.locator("button.chat-pane__sharing-trigger").waitFor({ state: "visible" });
      expect(await sharing.boundingBox()).toEqual(cachedSharingBox);
      await gateway.emitGatewayEvent("presence", { presence: hello?.snapshot?.presence });
      await viewers("5");
      expect(await cachedAvatar?.evaluate((element) => element.isConnected)).toBe(true);
      const frames: unknown[] = await page.evaluate(() => Reflect.get(window, "headerFrames"));
      expect(frames.length).toBeGreaterThan(0);
      expect(frames).toEqual(frames.map(() => ["5", cachedFacesBox?.x]));
      await header.screenshot({
        animations: "disabled",
        path: path.join(outputDir, `${face}-header.png`),
      });
      const people = await openChatDetailsPeople(page);
      const members = people.locator(".chat-details-people__person");
      for (const name of ["Ada", "Zoe"]) {
        await members.filter({ hasText: name }).waitFor({ state: "visible" });
      }
      expect(await members.count()).toBe(2);
      expect(
        await members
          .filter({ hasText: "Ada" })
          .locator(".chat-details-people__role")
          .textContent(),
      ).toBe("Owner");
      for (const presence of [
        [],
        [{ ts: 1, user: { id: "new-viewer", name: "New viewer" }, watchedSessions: [sessionKey] }],
      ]) {
        await gateway.emitGatewayEvent("presence", { presence });
        await count(".chat-pane__presence", presence.length);
        if (presence.length) {
          await count('[data-viewer-id="new-viewer"]', 1);
          await viewers("1");
        }
        expect(await members.count()).toBe(2);
        expect(await people.locator(".chat-details-people__person:visible").count()).toBe(2);
      }
    },
  );
}
suite.define(() =>
  it.each(["chat", "dashboard"] as const)(
    "retains cached header facts through %s reconnect",
    checkHeader,
  ),
);
