import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { chatFixture, timedText } from "./chat-flow-fixtures.test-support.ts";
import { controlUiSessionUrl, createChatFlowE2eSuite } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("keeps self-only People and empty desktop status hidden through delayed viewer resolution", async () => {
    const sessionKey = "agent:main:sidebar-cleanup";
    const identity = { type: "profile", id: "profile-alex" };
    const actor = { type: "human", id: "profile-alex", identity, label: "Alex Morgan" };
    const { page, gateway } = await chatFixture(
      suite,
      {
        sessionKey,
        sessions: [
          {
            key: sessionKey,
            kind: "direct",
            label: "Sidebar cleanup",
            updatedAt: Date.now(),
            owner: { actor },
            createdActor: actor,
            participants: [{ identity, label: "Alex Morgan" }],
            participantCount: 1,
          },
        ],
        historyMessages: [
          timedText(
            "user",
            "Please simplify the session sidebar and keep the conversation focused.",
          ),
          timedText(
            "assistant",
            "I will keep session details available when there is something useful to show.",
          ),
        ],
        deferredMethods: ["users.self"],
        methodResponses: { "users.self": { profile: { id: "profile-alex", name: "Alex Morgan" } } },
      },
      { viewport: { width: 1500, height: 920 }, colorScheme: "dark" },
    );
    await page.setViewportSize({ width: 1700, height: 1000 });
    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
    await page
      .getByText("Please simplify the session sidebar and keep the conversation focused.", {
        exact: true,
      })
      .waitFor();
    await gateway.waitForRequest("users.self");
    const details = page.locator(".chat-details[data-desktop]");
    await details.waitFor({ state: "attached" });
    const proofDir = process.env.OPENCLAW_STATUS_PROOF_DIR;
    if (proofDir) {
      await fs.mkdir(proofDir, { recursive: true });
      await page.screenshot({ path: path.join(proofDir, "identity-pending.png"), fullPage: true });
    }
    const pendingPeople = await details.locator('[data-details-group="people"]').count();
    await gateway.resolveDeferred("users.self", {
      profile: { id: "profile-alex", name: "Alex Morgan", createdAt: 1, updatedAt: 1 },
    });
    await page.waitForTimeout(250);
    if (proofDir) {
      await page.screenshot({ path: path.join(proofDir, "self-only-ready.png"), fullPage: true });
    }
    expect(pendingPeople).toBe(0);
    expect(await details.locator('[data-details-group="people"]').count()).toBe(0);
    expect(await details.getAttribute("role")).not.toBe("complementary");
  });
  it("omits the desktop status surface for a conversation with no visible sections", async () => {
    const sessionKey = "agent:main:empty-status";
    const { page } = await chatFixture(suite, {
      sessionKey,
      sessions: [
        { key: sessionKey, kind: "direct", label: "Focused conversation", updatedAt: Date.now() },
      ],
      historyMessages: [
        timedText("user", "Keep the conversation focused when there are no session details."),
        timedText("assistant", "There is no additional status to display for this conversation."),
      ],
    });
    await page.setViewportSize({ width: 1700, height: 1000 });
    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
    await page
      .getByText("Keep the conversation focused when there are no session details.", {
        exact: true,
      })
      .waitFor();
    const details = page.locator(".chat-details[data-desktop]");
    await details.waitFor({ state: "attached" });
    const proofDir = process.env.OPENCLAW_STATUS_PROOF_DIR;
    if (proofDir) {
      await fs.mkdir(proofDir, { recursive: true });
      await page.screenshot({ path: path.join(proofDir, "empty-status.png"), fullPage: true });
    }
    expect(await details.locator("[data-details-group]").count()).toBe(0);
    expect(await details.getAttribute("role")).not.toBe("complementary");
    expect(await details.getAttribute("inert")).not.toBeNull();
  });
});
