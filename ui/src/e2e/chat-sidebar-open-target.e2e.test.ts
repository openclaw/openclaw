import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
} from "../test-helpers/control-ui-e2e.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const sessionKey = "agent:main:main";
const artifactId = "artifact_managed_media_11111111-1111-4111-8111-111111111111";
const attachment = {
  artifactId,
  url: "/api/chat/media/outgoing/agent%3Amain%3Amain/11111111-1111-4111-8111-111111111111/full",
  kind: "document",
  label: "open-target.txt",
  mimeType: "text/plain",
  sizeBytes: 24,
};

suite.define(() => {
  it.each(["main", "side"] as const)(
    "opens an attachment in mobile Files when Files occupies %s",
    async (placement) => {
      await suite.withPage({ viewport: { width: 390, height: 844 } }, async ({ page }) => {
        await page.addInitScript(
          ({ key, settings }) => localStorage.setItem(key, JSON.stringify(settings)),
          {
            key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
            settings: {
              sidebarSessionLayouts: {
                [sessionKey]: {
                  columns: [
                    {
                      id: "side",
                      side: "right",
                      panels: ["conversation", "workspace", "detail"].map((slot) => ({
                        id: slot,
                        slot,
                      })),
                      activePanelId: "detail",
                      width: 480,
                      height: 360,
                    },
                  ],
                  mainPanelId: placement === "main" ? "workspace" : "conversation",
                  open: false,
                },
              },
            },
          },
        );
        await page.route("**/downloads/open-target.txt", (route) =>
          route.fulfill({ contentType: "text/plain", body: "The selected attachment." }),
        );
        await installMockGateway(page, {
          historyMessages: [
            {
              role: "assistant",
              content: [{ type: "attachment", attachment }],
              timestamp: 1_700_000_000_000,
            },
          ],
          methodResponses: {
            "artifacts.download": {
              artifact: {
                id: artifactId,
                type: "attachment",
                title: "open-target.txt",
                mimeType: "text/plain",
                sizeBytes: 24,
                download: { mode: "url" },
              },
              url: "/downloads/open-target.txt",
              expiresAt: "2100-01-01T00:00:00.000Z",
            },
            "artifacts.list": { artifacts: [] },
            "sessions.files.list": { sessionKey, root: "/workspace", files: [] },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const card = page.locator(".chat-assistant-attachment-card--compact");
        const input = page.locator(".agent-chat__input textarea");
        await input.fill("Keep the current draft");
        await card.locator(".chat-assistant-attachment-card__expand").click();

        const host = page.locator(".chat-mobile-host");
        await expect
          .poll(() => host.getByText("The selected attachment.", { exact: true }).isVisible())
          .toBe(true);
        await expect.poll(() => host.textContent()).toContain("open-target.txt");
        expect(await input.inputValue()).toBe("Keep the current draft");
      });
    },
  );
});
