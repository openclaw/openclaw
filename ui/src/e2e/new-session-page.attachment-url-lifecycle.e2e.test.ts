import { expect, it } from "vitest";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
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
  deferredReads: number;
  releaseDeferredReads: () => void;
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
        const deferredReads: Array<{ blob: Blob; reader: FileReader }> = [];
        const proof: AttachmentUrlProof = {
          created: [],
          revoked: [],
          deferNextRead: false,
          deferredReads: 0,
          releaseDeferredReads: () => {
            for (const { blob, reader } of deferredReads.splice(0)) {
              readAsDataURL.call(reader, blob);
            }
            proof.deferredReads = 0;
          },
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
          deferredReads.push({ blob, reader: this });
          proof.deferredReads = deferredReads.length;
        };
      });
      await installMockGateway(page, {
        methodResponses: {
          "agents.list": {
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
            agents: [
              { id: "main", name: "Main" },
              { id: "writer", name: "Writer" },
            ],
          },
          "sessions.create": { key: "agent:main:preview-cleanup", runStarted: true },
        },
      });
      const readObjectUrlState = () =>
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
      const expectActiveObjectUrls = (active: number) =>
        expect.poll(readObjectUrlState).toEqual({
          active,
          created: expect.any(Number),
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
        await expectActiveObjectUrls(0);
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
          page.evaluate(
            () =>
              document
                .querySelector(".new-session-page__select--agent .agent-select__menu")
                ?.matches(":popover-open") ?? false,
          ),
        )
        .toBe(false);
      await pollCount(thumbnails).toBe(0);
      await expectActiveObjectUrls(0);

      await page.evaluate(() => {
        window.attachmentUrlProof.deferNextRead = true;
      });
      await navigate("new-session");
      await composer.waitFor();
      await expect.poll(() => page.evaluate(() => window.attachmentUrlProof.deferredReads)).toBe(1);
      const createdBeforeHydration = (await readObjectUrlState()).created;
      await page.evaluate(() => window.attachmentUrlProof.releaseDeferredReads());
      await expect.poll(readObjectUrlState).toEqual({
        active: 1,
        created: createdBeforeHydration + 1,
        duplicateRevocations: 0,
        unknownRevocations: 0,
      });
      await pollCount(thumbnails).toBe(1);
      await remove();

      await paste();
      await waitForCommittedNewSessionDraft(page, "", 1);
      await navigate("chat");
      await page.waitForURL((url) => url.pathname.endsWith("/chat"));
      await expectActiveObjectUrls(1);

      await navigate("new-session");
      await composer.waitFor();
      await pollCount(thumbnails).toBe(1);
      await remove();

      await paste();
      await expectActiveObjectUrls(1);
      await page.getByRole("button", { name: "Start session" }).click();
      await page.waitForURL(
        (url) => url.pathname === controlUiSessionPath("agent:main:preview-cleanup"),
      );
      await expectActiveObjectUrls(0);
    });
  });
});
