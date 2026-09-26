import path from "node:path";
import { expect, type Page } from "playwright/test";
import { beforeEach, it } from "vitest";
// Control UI E2E tests cover suggestion queue and solo-dormancy behavior.
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI session suggestions",
  startServerBeforeBrowser: true,
});

const sessionKey = "agent:main:main";

let proofArtifactDir: string | undefined;
beforeEach(() => {
  const parent = process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR?.trim();
  proofArtifactDir = parent
    ? createControlUiE2eArtifactDir("session-suggestions", parent)
    : undefined;
});

async function contextAndPage() {
  const output = proofArtifactDir;
  const context = await suite.browser.newContext({
    viewport: { height: 760, width: 1180 },
    ...(output ? { recordVideo: { dir: output, size: { height: 760, width: 1180 } } } : {}),
  });
  return { context, page: await context.newPage() };
}

async function screenshot(page: Page, name: string) {
  const output = proofArtifactDir;
  if (output) {
    await page.screenshot({ animations: "disabled", path: path.join(output, name) });
  }
}

function sessionRow(sharingRole: "owner" | "viewer", kind: "direct" | "group" = "direct") {
  return {
    count: 1,
    defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
    path: "",
    sessions: [
      {
        key: sessionKey,
        kind,
        label: "Main",
        sessionId: "session-main",
        status: "done",
        updatedAt: 1,
        visibility: "suggest",
        sharingRole,
      },
    ],
    ts: 1,
  };
}

const featureMethods = [
  "chat.metadata",
  "chat.startup",
  "commands.list",
  "session.suggestions.add",
  "session.suggestions.list",
  "session.suggestions.resolve",
  "session.typing",
];

suite.define(() => {
  it("submits a viewer draft as a suggestion and shows its pending state", async () => {
    const { context, page } = await contextAndPage();
    const suggestion = {
      id: "suggestion-1",
      sessionKey,
      agentId: "main",
      author: { type: "human", id: "alice", label: "Alice" },
      text: "Try the focused change",
      createdAt: 1,
      state: "pending",
    };
    const gateway = await installMockGateway(page, {
      featureMethods,
      presenceUsers: [
        {
          self: true,
          id: "alice",
          name: "Alice",
          watchedSessions: ["main", sessionKey],
        },
        { id: "owner", name: "Owner", watchedSessions: ["main", sessionKey] },
      ],
      methodResponses: {
        "sessions.list": sessionRow("viewer"),
        "session.suggestions.list": { suggestions: [], role: "viewer" },
        "session.suggestions.add": { suggestion },
        "session.typing": { ok: true, broadcast: true },
      },
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
    const composer = page.locator(".agent-chat__composer-combobox textarea");
    const modelTrigger = page.locator(".chat-controls__model-trigger");
    const typingRow = page.locator('[data-virtual-row-key="presence:typing"]');
    const typingIndicator = typingRow.locator(".agent-chat__typing-indicator");
    await gateway.waitForRequest("session.suggestions.list");
    await expect(composer).toBeEnabled();
    await modelTrigger.waitFor();
    const idleModelBox = await modelTrigger.boundingBox();
    if (idleModelBox === null) {
      throw new Error("Expected the model trigger before remote typing");
    }
    await expect(typingIndicator).toHaveCount(0);
    await gateway.emitGatewayEvent("session.typing", {
      sessionKey: "main",
      sessionId: "session-main",
      agentId: "main",
      actor: { type: "human", id: "owner", label: "Owner" },
      typing: true,
      ts: Date.now(),
    });
    await expect(typingIndicator.locator(".sr-only")).toHaveText("Owner is typing…");
    const [typingModelBox, typingRowBox, composerShellBox] = await Promise.all([
      modelTrigger.boundingBox(),
      typingRow.boundingBox(),
      page.locator(".agent-chat__composer-shell").boundingBox(),
    ]);
    if (typingModelBox === null || typingRowBox === null || composerShellBox === null) {
      throw new Error("Expected the transcript typing row and stable composer layout");
    }
    expect(Math.abs(typingModelBox.x - idleModelBox.x)).toBeLessThanOrEqual(0.5);
    // The #122809 regression shifted the picker by a full indicator row
    // (~20px); allow subpixel/rounding jitter seen on CI renderers (2.41px).
    expect(Math.abs(typingModelBox.y - idleModelBox.y)).toBeLessThanOrEqual(4);
    expect(typingRowBox.y + typingRowBox.height).toBeLessThanOrEqual(composerShellBox.y + 1);
    await gateway.emitGatewayEvent("session.message", {
      sessionKey: "main",
      agentId: "main",
      message: {
        role: "user",
        content: "Owner finished typing",
        __openclaw: {
          senderId: "owner",
          senderName: "Owner",
          senderIdentity: { type: "profile", id: "owner" },
        },
      },
    });
    await expect(typingIndicator).toHaveCount(0);
    await composer.fill("Try the focused change");
    const typing = await gateway.waitForRequest("session.typing");
    expect(typing.params).toMatchObject({
      sessionId: "session-main",
      preview: "Try the focused change",
    });
    await page.getByRole("button", { name: "Suggest message" }).click();
    const add = await gateway.waitForRequest("session.suggestions.add");
    expect(add.params).toMatchObject({
      sessionKey: "agent:main:main",
      text: "Try the focused change",
    });
    await expect(page.locator(".session-suggestion__state")).toHaveText("Pending");
    await expect(page.locator(".session-suggestion__text")).toHaveText("Try the focused change");
    await screenshot(page, "viewer-pending.png");
    await context.close();
  });

  it("does not offer live-session commands in a viewer suggestion composer", async () => {
    const { context, page } = await contextAndPage();
    const gateway = await installMockGateway(page, {
      featureMethods,
      presenceUsers: [
        { self: true, id: "alice", name: "Alice", watchedSessions: ["main", sessionKey] },
        { id: "owner", name: "Owner", watchedSessions: ["main", sessionKey] },
      ],
      methodResponses: {
        "commands.list": {
          commands: [
            {
              acceptsArgs: false,
              description: "Show gateway status.",
              name: "status",
              scope: "both",
              source: "native",
              textAliases: ["/status"],
            },
          ],
        },
        "sessions.list": sessionRow("viewer"),
        "session.suggestions.list": { suggestions: [], role: "viewer" },
      },
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
    await gateway.waitForRequest("session.suggestions.list");
    const composer = page.locator(".agent-chat__composer-combobox textarea");
    await expect(composer).toBeEnabled();
    await composer.fill("Keep this /sta");
    await gateway.waitForRequest("commands.list");
    await expect(page.getByRole("option", { name: /\/status/u })).toHaveCount(0);
    await composer.fill("/bt");
    await page.getByRole("option").filter({ hasText: "/btw" }).click();
    expect(await gateway.getRequests("session.suggestions.add")).toHaveLength(0);
    await expect(composer).toHaveValue("/btw ");
    expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    await context.close();
  });

  it.each(["direct", "group"] as const)(
    "streams a remote draft into a live preview bubble (%s)",
    async (kind) => {
      const { context, page } = await contextAndPage();
      const gateway = await installMockGateway(page, {
        featureMethods,
        presenceUsers: [
          {
            self: true,
            id: "alice",
            identity: { type: "profile" as const, id: "alice" },
            name: "Alice",
            watchedSessions: ["main", sessionKey],
          },
          { id: "owner", name: "Owner", watchedSessions: ["main", sessionKey] },
          { id: "zoe", name: "Zoe", watchedSessions: ["main", sessionKey] },
        ],
        methodResponses: {
          "sessions.list": sessionRow("viewer", kind),
          "session.suggestions.list": { suggestions: [], role: "viewer" },
          "session.typing": { ok: true, broadcast: true },
        },
        sessions: sessionRow("viewer", kind).sessions,
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const typingRow = page.locator('[data-virtual-row-key="presence:typing"]');
      const previewBubble = typingRow.locator(".agent-chat__typing-preview-text");
      await gateway.waitForRequest("session.suggestions.list");
      await expect(page.locator(".agent-chat__composer-combobox textarea")).toBeEnabled();

      await page.clock.install();
      const ownerTyping = (preview?: string) =>
        gateway.emitGatewayEvent("session.typing", {
          sessionKey: "main",
          sessionId: "session-main",
          agentId: "main",
          actor: { type: "human", id: "owner", label: "Owner" },
          typing: true,
          ...(preview ? { preview } : {}),
          ts: Date.now(),
        });

      await ownerTyping();
      await expect(typingRow.locator(".agent-chat__typing-bubble > span")).toHaveCount(3);
      await expect(previewBubble).toHaveCount(0);
      await expect(
        typingRow.locator(".chat-message-avatar-anchor > :is(.chat-avatar, .chat-avatar-slot)"),
      ).toBeVisible();
      await screenshot(page, "typing-dots-before.png");

      const draft = "yea, cool. Live drafts stream into the bubble now.";
      let visible = "";
      for (const word of draft.split(" ")) {
        visible = visible ? `${visible} ${word}` : word;
        await ownerTyping(visible);
        await expect(previewBubble).toHaveText(visible);
        if (proofArtifactDir) {
          // Readability pacing for the recorded artifact only; assertions above
          // already proved each chunk rendered.
          await page.waitForTimeout(160);
        }
      }
      await expect(typingRow.locator(".agent-chat__typing-preview-label")).toHaveText("Owner");
      await expect(typingRow.locator(".agent-chat__typing-state")).toHaveText("Typing · not sent");
      await expect(typingRow.locator(".agent-chat__typing-bubble")).toHaveCount(0);
      await screenshot(page, "typing-preview-live.png");
      const activeBox = await previewBubble.boundingBox();
      await page.clock.runFor(3_000);
      await expect(previewBubble).toHaveText(draft);
      await expect(typingRow.locator(".agent-chat__typing-state")).toHaveText("Paused · not sent");
      await expect(typingRow.locator(".sr-only")).toBeEmpty();
      expect(await previewBubble.boundingBox()).toEqual(activeBox);
      expect(
        await previewBubble.evaluate(
          (element) => getComputedStyle(element, "::after").animationName,
        ),
      ).toBe("none");
      await screenshot(page, "typing-preview-paused.png");

      await gateway.emitGatewayEvent("session.typing", {
        sessionKey: "main",
        sessionId: "session-main",
        agentId: "main",
        actor: { type: "human", id: "zoe", label: "Zoe" },
        typing: true,
        ts: Date.now(),
      });
      await ownerTyping(draft);
      await expect(typingRow.locator(".agent-chat__typing-bubble > span")).toHaveCount(3);
      await expect(previewBubble).toHaveText(draft);
      const status = typingRow.locator(".sr-only");
      await expect(status).toHaveText("Owner, Zoe are typing…");
      await expect(status).not.toContainText("yea, cool");
      await screenshot(page, "typing-preview-and-dots.png");

      await gateway.emitGatewayEvent("session.typing", {
        sessionKey: "main",
        sessionId: "session-main",
        agentId: "main",
        actor: { type: "human", id: "zoe", label: "Zoe" },
        typing: false,
        ts: Date.now(),
      });
      const geometry = () =>
        previewBubble.evaluate((element) => {
          const text = getComputedStyle(element);
          const bubble = element.closest(".chat-bubble")!;
          const skin = getComputedStyle(bubble);
          const box = bubble.getBoundingClientRect();
          return {
            x: box.x,
            y: box.y,
            padding: skin.padding,
            radius: skin.borderRadius,
            font: text.font,
            background: skin.backgroundColor,
          };
        });
      for (const [mode, width, height] of [
        ["light", 1180, 760],
        ["dark", 1180, 760],
        ["light", 390, 844],
        ["dark", 390, 844],
      ] as const) {
        await page.setViewportSize({ width, height });
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.dataset.themeMode = theme;
        }, mode);
        const multiline =
          "A draft can span lines.\nEmoji stay intact 👩🏽‍💻 — and a long word wraps: " +
          "draft".repeat(35);
        await ownerTyping(multiline);
        await expect(previewBubble).toHaveText(multiline);
        await expect(typingRow.locator(".agent-chat__typing-state")).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        expect(
          await previewBubble.evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
        if (proofArtifactDir) {
          await page.locator(".chat-thread").screenshot({
            path: path.join(proofArtifactDir, `typing-${mode}-${width}.png`),
            animations: "disabled",
          });
        }
      }
      await page.emulateMedia({ reducedMotion: "reduce" });
      await ownerTyping("مسودة لم ترسل بعد 👋");
      await expect(previewBubble).toHaveCSS("direction", "rtl");
      expect(
        await previewBubble.evaluate(
          (element) => getComputedStyle(element, "::after").animationName,
        ),
      ).toBe("none");
      await page.setViewportSize({ width: 1180, height: 760 });
      await page.evaluate(() => {
        document.documentElement.dataset.theme = "light";
        document.documentElement.dataset.themeMode = "light";
      });
      await ownerTyping(draft);
      await expect(previewBubble).toHaveText(draft);
      await expect
        .poll(() =>
          typingRow
            .locator(".chat-group")
            .evaluate((row) => Number.parseFloat(getComputedStyle(row).gridTemplateColumns)),
        )
        .toBeGreaterThan(0);
      const beforeSend = await geometry();
      await gateway.emitGatewayEvent("session.message", {
        sessionKey: "main",
        sessionId: "session-main",
        agentId: "main",
        message: {
          role: "user",
          content: draft,
          timestamp: Date.now(),
          __openclaw: {
            id: "sent-owner-draft",
            senderId: "owner",
            senderName: "Owner",
            senderIdentity: { type: "profile", id: "owner" },
          },
        },
      });
      await expect(typingRow).toHaveCount(0);
      const sentText = page.locator(".chat-group--peer .chat-text").filter({ hasText: draft });
      await expect(sentText).toHaveCount(1);
      const afterSend = await sentText.evaluate((element) => {
        const text = getComputedStyle(element);
        const bubble = element.closest(".chat-bubble")!;
        const skin = getComputedStyle(bubble);
        const box = bubble.getBoundingClientRect();
        return {
          x: box.x,
          y: box.y,
          padding: skin.padding,
          radius: skin.borderRadius,
          font: text.font,
          background: skin.backgroundColor,
        };
      });
      expect(afterSend.padding).toBe(beforeSend.padding);
      expect(afterSend.radius).toBe(beforeSend.radius);
      expect(afterSend.font).toBe(beforeSend.font);
      expect(afterSend.x).toBeCloseTo(beforeSend.x, 0);
      expect(afterSend.y).toBeCloseTo(beforeSend.y, 0);
      expect(afterSend.background).not.toBe(beforeSend.background);
      if (proofArtifactDir) {
        await page.locator(".chat-thread").screenshot({
          path: path.join(proofArtifactDir, "typing-sent.png"),
          animations: "disabled",
        });
      }
      await ownerTyping("Another unsent draft");
      await expect(previewBubble).toHaveText("Another unsent draft");
      await page.clock.runFor(3_000);
      await expect(typingRow.locator(".agent-chat__typing-state")).toHaveText("Paused · not sent");
      await gateway.emitGatewayEvent("presence", {
        presence: ["alice", "owner", "zoe"].map((id) => ({
          ts: Date.now(),
          user: { id, identity: { type: "profile", id } },
          watchedSessions: id === "owner" ? ["agent:main:other"] : [sessionKey],
        })),
      });
      await expect(typingRow).toHaveCount(0);
      await context.close();
    },
  );

  it("shows four owner actions and loads edit into the composer", async () => {
    const { context, page } = await contextAndPage();
    const suggestion = {
      id: "suggestion-2",
      sessionKey,
      agentId: "main",
      author: { type: "human", id: "alice", label: "Alice" },
      text: "Please edit this first",
      createdAt: 2,
      state: "pending",
    };
    const gateway = await installMockGateway(page, {
      deferredMethods: ["session.suggestions.resolve"],
      featureMethods,
      presenceUsers: [
        { self: true, id: "owner", name: "Owner", watchedSessions: ["main", sessionKey] },
        { id: "alice", name: "Alice", watchedSessions: ["main", sessionKey] },
      ],
      methodResponses: {
        "sessions.list": sessionRow("owner"),
        "session.suggestions.list": { suggestions: [suggestion], role: "owner" },
      },
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
    const row = page.locator(".session-suggestion");
    await expect(row).toBeVisible();
    await expect(row.locator("button")).toHaveCount(4);
    expect(
      await row
        .locator("button")
        .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label"))),
    ).toEqual([
      "Send Alice's suggestion now",
      "Queue Alice's suggestion",
      "Edit Alice's suggestion",
      "Dismiss Alice's suggestion",
    ]);
    await page.getByRole("button", { name: "Edit Alice's suggestion" }).click();
    await gateway.waitForRequest("session.suggestions.resolve");
    const composer = page.locator(".agent-chat__composer-combobox textarea");
    await expect(composer).toHaveValue("Please edit this first");
    await composer.fill("A newer owner draft");
    await gateway.resolveDeferred("session.suggestions.resolve", {
      suggestion: { ...suggestion, state: "accepted" },
    });
    await expect(composer).toHaveValue("A newer owner draft");
    await screenshot(page, "owner-edit.png");
    await context.close();
  });

  it("keeps suggestion and typing UI dormant with one identity", async () => {
    const { context, page } = await contextAndPage();
    const gateway = await installMockGateway(page, {
      featureMethods,
      presenceUsers: [
        {
          self: true,
          id: "alice",
          name: "Alice",
          watchedSessions: ["main", sessionKey],
        },
      ],
      methodResponses: { "sessions.list": sessionRow("viewer") },
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
    await expect(page.locator(".agent-chat__composer-combobox textarea")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Suggest message" })).toHaveCount(0);
    await expect(page.locator(".agent-chat__typing-indicator")).toHaveCount(0);
    expect(await gateway.getRequests("session.suggestions.list")).toEqual([]);
    await screenshot(page, "solo-dormant.png");
    await context.close();
  });

  it("keeps older gateways read-only when suggestion RPCs are not advertised", async () => {
    const { context, page } = await contextAndPage();
    await installMockGateway(page, {
      presenceUsers: [
        { self: true, id: "alice", name: "Alice", watchedSessions: ["main"] },
        { id: "owner", name: "Owner", watchedSessions: ["main"] },
      ],
      methodResponses: { "sessions.list": sessionRow("viewer") },
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
    await expect(page.locator(".agent-chat__composer-combobox textarea")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Suggest message" })).toHaveCount(0);
    await context.close();
  });
});
