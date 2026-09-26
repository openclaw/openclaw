import { writeFile } from "node:fs/promises";
import path from "node:path";
import { GATEWAY_SERVER_CAPS } from "@openclaw/gateway-protocol";
import { expect, it } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

type UnreadProofApp = HTMLElement & { runtime?: { context: ApplicationContext } };

suite.define(() => {
  it("does not repeat an automatic unread acknowledgement after its own rejected response", async () => {
    const artifactDir = createControlUiE2eArtifactDir("chat-unread-ack-rejection");
    const context = await suite.newBrowserContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    try {
      const page = await context.newPage();
      const key = "agent:main:unread-rejection";
      const historyText = "Shared session history remains available.";
      const denial = "Synthetic acknowledgement rejection";
      const session = createControlUiSessionRow(key, "Shared unread session", 20, {
        icon: "📬",
        unread: true,
        visibility: "shared",
        sharingRole: "member",
      });
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.write"],
        featureCapabilities: [GATEWAY_SERVER_CAPS.SESSION_UNREAD_ACK_CONTRACT],
        hasMultipleSessionSharingIdentities: false,
        historyMessages: [{ role: "assistant", content: historyText }],
        sessions: [session],
        sessionKey: key,
        // Reject only the first acknowledgement; any regression requests remain held until close.
        deferredMethods: ["sessions.patch", "sessions.patch", "sessions.patch"],
        methodResponses: {
          "sessions.list": chatSessionListResponse([session]),
          "sessions.patch": {},
        },
      });
      const match = { key, unread: false };
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
      await page.getByText(historyText, { exact: true }).waitFor({ state: "visible" });
      const acknowledgement = await gateway.waitForRequest("sessions.patch", { match });
      expect(acknowledgement.params).toMatchObject({ expectedMarkedUnreadAt: null });
      await page.screenshot({
        animations: "disabled",
        path: path.join(artifactDir, "01-opened.png"),
      });

      await gateway.rejectDeferred("sessions.patch", {
        code: "INVALID_REQUEST",
        message: denial,
      });
      await page.waitForFunction((message) => {
        const app = document.querySelector("openclaw-app") as UnreadProofApp | null;
        return app?.runtime?.context.sessions.state.error?.includes(message) === true;
      }, denial);
      await page.screenshot({
        animations: "disabled",
        path: path.join(artifactDir, "02-rejected.png"),
      });
      const observed = await page.evaluate((sessionKey) => {
        const app = document.querySelector("openclaw-app") as UnreadProofApp | null;
        const state = app?.runtime?.context.sessions.state;
        const row = state?.result?.sessions.find((candidate) => candidate.key === sessionKey);
        return {
          error: state?.error,
          unread: row?.unread,
          markedUnreadAt: row?.markedUnreadAt ?? null,
        };
      }, key);
      await writeFile(
        path.join(artifactDir, "rejection-observation.json"),
        JSON.stringify(
          {
            syntheticOnly: true,
            sessionKey: key,
            expectedAcknowledgements: 1,
            requestsAfterRejection: await gateway.getRequests("sessions.patch", match),
            observed,
          },
          null,
          2,
        ) + "\n",
      );

      expect(await gateway.getRequests("sessions.patch", match)).toHaveLength(1);
      const unreadBadge = page
        .locator(`.sidebar-recent-session[data-session-key="${key}"]`)
        .locator(".sidebar-session-indicator .session-glyph__badge--unread");
      await unreadBadge.waitFor({ state: "visible" });
      expect(observed).toMatchObject({ unread: true, markedUnreadAt: null });
      expect(observed.error).toContain(denial);
      expect(await page.getByText(historyText, { exact: true }).isVisible()).toBe(true);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
