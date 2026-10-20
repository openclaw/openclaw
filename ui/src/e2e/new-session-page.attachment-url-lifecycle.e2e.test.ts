import { expect, it } from "vitest";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import { navigationAgents } from "./new-session-page.navigation-fixtures.test-support.ts";
import {
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  installMockGateway,
  navigateInApp,
  pastePng,
  pollCount,
  waitForCommittedNewSessionDraft,
} from "./new-session-page.test-support.ts";

type AttachmentUrlProof = {
  created: string[];
  revoked: string[];
  deferNextRead: boolean;
  pending: Array<() => void>;
};

declare global {
  interface Window {
    attachmentUrlProof: AttachmentUrlProof;
  }
}

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it("releases pasted image previews after remove, reset, restored removal, and success", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      await page.addInitScript(() => {
        const createObjectURL = URL.createObjectURL.bind(URL);
        const revokeObjectURL = URL.revokeObjectURL.bind(URL);
        const readAsDataURL = FileReader.prototype.readAsDataURL;
        const proof: AttachmentUrlProof = {
          created: [],
          revoked: [],
          deferNextRead: false,
          pending: [],
        };
        window.attachmentUrlProof = proof;
        URL.createObjectURL = (blob: Blob) => {
          const url = createObjectURL(blob);
          proof.created.push(url);
          return url;
        };
        URL.revokeObjectURL = (url: string) => {
          proof.revoked.push(url);
          revokeObjectURL(url);
        };
        FileReader.prototype.readAsDataURL = function (blob: Blob) {
          if (!proof.deferNextRead) {
            return readAsDataURL.call(this, blob);
          }
          proof.deferNextRead = false;
          proof.pending.push(() => readAsDataURL.call(this, blob));
        };
      });
      await installMockGateway(page, {
        methodResponses: {
          "agents.list": navigationAgents(["main", "writer"]),
          "sessions.create": { key: "agent:main:preview-cleanup", runStarted: true },
        },
      });
      const readUrls = () =>
        page.evaluate(() => {
          const proof = window.attachmentUrlProof;
          const created = new Set(proof.created);
          const revoked = new Set(proof.revoked);
          return {
            active: proof.created.filter((url) => !revoked.has(url)).length,
            created: proof.created.length,
            duplicateRevocations: proof.revoked.length - revoked.size,
            unknownRevocations: proof.revoked.filter((url) => !created.has(url)).length,
          };
        });
      const expectUrls = (active: number, created?: number) =>
        expect.poll(readUrls).toEqual({
          active,
          created: created ?? expect.any(Number),
          duplicateRevocations: 0,
          unknownRevocations: 0,
        });
      const navigate = (routeId: Parameters<typeof navigateInApp>[1], search = "") =>
        navigateInApp(page, routeId, search);
      await page.goto(`${suite.server.baseUrl}new`);
      const composer = page.locator(".new-session-page__message");
      const thumbnails = page.locator(".chat-attachment-thumb");
      const paste = async () => {
        await pastePng(composer);
        await page.getByRole("img", { name: "pixel.png" }).waitFor();
      };
      const remove = async () => {
        await page.getByRole("button", { name: "Remove pixel.png" }).click();
        await expectUrls(0);
      };

      await paste();
      await remove();

      await paste();
      await waitForCommittedNewSessionDraft(page, "", 1);
      // Synthetic paste leaves the pointer over the replacement remove button.
      await page.mouse.move(0, 0);
      const agentMenu = page.locator(".new-session-page__select--agent .agent-select__menu");
      await page.locator(".new-session-page__select--agent .agent-select__trigger").click();
      await expect
        .poll(() => agentMenu.evaluate((menu) => menu.matches(":popover-open")))
        .toBe(true);
      await navigate("new-session", "?agent=main&catalog=missing");
      await expect
        .poll(() =>
          agentMenu.evaluateAll((menus) => menus.some((menu) => menu.matches(":popover-open"))),
        )
        .toBe(false);
      await pollCount(thumbnails).toBe(0);
      await expectUrls(0);

      await page.evaluate(() => {
        window.attachmentUrlProof.deferNextRead = true;
      });
      await navigate("new-session");
      await composer.waitFor();
      await expect
        .poll(() => page.evaluate(() => window.attachmentUrlProof.pending.length))
        .toBe(1);
      const createdBeforeHydration = (await readUrls()).created;
      await page.evaluate(() => {
        for (const read of window.attachmentUrlProof.pending.splice(0)) {
          read();
        }
      });
      await expectUrls(1, createdBeforeHydration + 1);
      await pollCount(thumbnails).toBe(1);
      await remove();

      await paste();
      await waitForCommittedNewSessionDraft(page, "", 1);
      await navigate("chat");
      await page.waitForURL((url) => url.pathname.endsWith("/chat"));
      await expectUrls(1);

      await navigate("new-session");
      await composer.waitFor();
      await pollCount(thumbnails).toBe(1);
      await remove();

      await paste();
      await expectUrls(1);
      await page.getByRole("button", { name: "Start session" }).click();
      await page.waitForURL(
        (url) => url.pathname === controlUiSessionPath("agent:main:preview-cleanup"),
      );
      await expectUrls(0);
    });
  });
});
