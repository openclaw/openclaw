import { expect, it } from "vitest";
import type { SessionMembersListEvidenceResult } from "../api/types.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();
const key = "agent:main:dashboard:4be0d2a1-5c0e-4a8e-9f61-0b1b6f3a2c11";
const owner = { type: "human" as const, id: "owner", label: "Owner Person" };
const member = { type: "human" as const, id: "member", label: "Member Person" };

function roster(level: "send" | "suggest"): SessionMembersListEvidenceResult {
  return {
    sessionKey: key,
    owner,
    members: level === "send" ? [{ identityId: member.id, addedBy: owner.id, addedAt: 1 }] : [],
    identities: [owner, member],
    permissions: [{ identityId: member.id, level, options: ["suggest", "send"] }],
    role: "owner",
    allowedVisibilities: ["shared", "read-only", "suggest", "draft"],
  };
}

suite.define(() => {
  it("shows the refreshed roster after a member access change", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          sessionKey: key,
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            "session.visibility.set",
            "session.members.listEvidence",
            "session.members.add",
            "session.members.remove",
            "session.publicShare.set",
          ],
          operatorScopes: ["operator.read", "operator.write"],
          methodResponses: {
            "sessions.list": sessionsListResponse([
              sessionRow(key, "Sharing access change", Date.now(), {
                sharingRole: "owner",
                visibility: "suggest",
              }),
            ]),
            "session.members.listEvidence": roster("send"),
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
        await page.locator(".chat-pane__sharing-trigger").filter({ visible: true }).click();
        const panel = page.locator(".chat-pane__sharing-panel");
        await panel.waitFor();
        const control = panel.locator(
          '[data-value="member:member"] button.chat-pane__sharing-permission',
        );
        await expect.poll(() => control.textContent()).toBe("Can send");
        // This release changes participation through add/remove, not setAccess.
        await gateway.deferNext("session.members.remove");
        await control.click();
        await page.getByRole("menuitemradio", { name: "Can suggest" }).click();
        await gateway.waitForRequest("session.members.remove", {
          match: { sessionKey: key, identityId: member.id },
        });
        await expect.poll(() => control.getAttribute("title")).toBe("Loading…");

        // The Gateway broadcasts the sharing change before it answers the write.
        await gateway.setMethodResponse("session.members.listEvidence", roster("suggest"));
        await gateway.emitGatewayEvent("sessions.changed", {
          reason: "sharing",
          key,
          sessionKey: key,
          agentId: "main",
        });
        await gateway.resolveDeferred("session.members.remove", {
          ok: true,
          sessionKey: key,
          identityId: member.id,
        });

        await expect.poll(() => control.textContent()).toBe("Can suggest");
        await expect.poll(() => control.getAttribute("aria-disabled")).toBeNull();
        expect(await control.getAttribute("title")).toBeNull();
        expect(await panel.getByRole("alert").count()).toBe(0);
      },
    );
  });
});
