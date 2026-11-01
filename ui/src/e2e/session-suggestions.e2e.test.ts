import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator } from "playwright/test";
import { it } from "vitest";
import { waitForLayoutSettled } from "../pages/chat/chat-layout.browser.test-support.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  pauseVirtualClock,
} from "../test-helpers/control-ui-e2e.ts";
import { sessionRow as makeRow } from "./chat-flow-fixtures.test-support.ts";
import { chatSessionListResponse } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { bounds } from "./session-management.compact.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI session suggestions",
  startServerBeforeBrowser: true,
  trackBrowserContexts: true,
});

const sessionKey = "agent:main:main";

const newPage = async () =>
  (await suite.newBrowserContext({ viewport: { height: 760, width: 1180 } })).newPage();

function presenceUser(
  id: "alice" | "owner" | "zoe",
  self = false,
  watchedSessions = ["main", sessionKey],
) {
  return {
    id,
    name: id === "alice" ? "Alice" : id === "zoe" ? "Zoe" : "Owner",
    ...(self ? { self } : {}),
    watchedSessions,
  };
}

function sessionRow(sharingRole: "owner" | "viewer", kind: "direct" | "group" = "direct") {
  return {
    ...chatSessionListResponse([
      makeRow(sessionKey, "Main", 1, {
        kind,
        sessionId: "session-main",
        status: "done",
        visibility: "suggest",
        sharingRole,
      }),
    ]),
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

async function openSuggestions(
  role: "owner" | "viewer",
  options: Parameters<typeof installMockGateway>[1] = {},
  kind: "direct" | "group" = "direct",
) {
  const page = await newPage();
  const gateway = await installMockGateway(page, {
    featureMethods,
    presenceUsers: [presenceUser("alice", true), presenceUser("owner")],
    ...options,
    methodResponses: {
      "sessions.list": sessionRow(role, kind),
      "session.suggestions.list": { suggestions: [], role },
      ...options.methodResponses,
    },
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
  await gateway.waitForRequest("session.suggestions.list");
  const composer = page.locator(".agent-chat__composer-combobox textarea");
  await expect(composer).toBeEnabled();
  return { page, gateway, composer };
}

function pendingSuggestion(id: string, text: string, createdAt: number) {
  return {
    id,
    sessionKey,
    agentId: "main",
    author: { type: "human", id: "alice", label: "Alice" },
    text,
    createdAt,
    state: "pending",
  };
}

function ownerMessage(content: string, metadata: Record<string, unknown> = {}) {
  return {
    role: "user",
    content,
    __openclaw: {
      senderId: "owner",
      senderName: "Owner",
      senderIdentity: { type: "profile", id: "owner" },
      ...metadata,
    },
  };
}

function typingEvent(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  options: Record<string, unknown> = {},
) {
  return gateway.emitGatewayEvent("session.typing", {
    sessionKey: "main",
    sessionId: "session-main",
    agentId: "main",
    actor: { type: "human", id: "owner", label: "Owner" },
    typing: true,
    ts: Date.now(),
    ...options,
  });
}

function caretPrefix(preview: Locator) {
  return preview.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.setEndBefore(element.querySelector(".agent-chat__typing-caret")!);
    return range.toString();
  });
}

function caretTextGeometry(preview: Locator) {
  return preview.evaluate((element) => {
    const caret = element.querySelector(".agent-chat__typing-caret")!;
    const box = caret.getBoundingClientRect();
    const style = getComputedStyle(caret, "::after");
    const height = Number.parseFloat(style.height);
    const bottom = box.bottom - Number.parseFloat(style.bottom);
    // A text Range supplies the font's actual inline box, not the line-height
    // or an em approximation. The first glyph stays on the first draft line.
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let text = walker.nextNode();
    while (text && !text.textContent) {
      text = walker.nextNode();
    }
    const range = document.createRange();
    range.setStart(text!, 0);
    range.setEnd(text!, 1);
    const glyph = range.getBoundingClientRect();
    return {
      top: bottom - height,
      height,
      textTop: glyph.top,
      textHeight: glyph.height,
      lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
    };
  });
}

function bubbleGeometry(locator: Locator) {
  return locator.evaluate((element) => {
    const text = getComputedStyle(element);
    const bubble = element.closest(".chat-bubble")!;
    const skin = getComputedStyle(bubble);
    const { x, y } = bubble.getBoundingClientRect();
    return {
      x,
      y,
      padding: skin.padding,
      radius: skin.borderRadius,
      font: text.font,
      background: skin.backgroundColor,
    };
  });
}

function afterAnimation(locator: Locator) {
  return locator.evaluate((element) => getComputedStyle(element, "::after").animationName);
}

suite.define(() => {
  it("keeps the watched caret at the writer's multiline edit position", async () => {
    const { page, gateway, composer } = await openSuggestions("owner", {
      presenceUsers: [
        presenceUser("alice", true, [sessionKey]),
        presenceUser("owner", false, [sessionKey]),
      ],
      sessions: sessionRow("owner").sessions,
      methodResponses: { "session.typing": { ok: true, broadcast: true } },
    });
    await page.clock.install();
    await pauseVirtualClock(page);
    const draft =
      "This is the last PR in a series.\n\nIt adds a requiredProfile.\nWe considered per-agent settings, but that can come later.\nAnd the last of several PRs.  \n";
    const cursor = draft.indexOf("series");
    await composer.fill(draft);
    await composer.evaluate(
      (element: HTMLTextAreaElement, offset) => element.setSelectionRange(offset, offset),
      cursor + 1,
    );
    await composer.press("ArrowLeft");
    await page.clock.runFor(250);
    const row = page.locator('[data-virtual-row-key="presence:typing"]');
    const preview = row.locator(".agent-chat__typing-preview-text");
    await typingEvent(gateway, {
      sessionKey,
      preview: draft,
      cursor,
    });
    await expect(preview).toHaveText(draft);
    const requests = await gateway.getRequests("session.typing");
    expect(requests.at(-1)?.params).toMatchObject({ preview: draft, cursor });
    const caret = preview.locator(".agent-chat__typing-caret");
    await expect(caret).toHaveCount(1);
    expect(await caretPrefix(preview)).toBe(draft.slice(0, cursor));
    if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
      const frame = await takeControlUiScreenshotFrame(page, row, [preview], {
        animations: "disabled",
        elements: [row],
      });
      await writeFile(path.join(suite.artifactDir, "typing-detail.png"), frame.elements[0]!.png);
      await writeFile(
        path.join(suite.artifactDir, "typing-geometry.json"),
        JSON.stringify(await caretTextGeometry(preview), null, 2),
      );
    }
    const firstLine = await caret.boundingBox();
    const initialPreview = await preview.boundingBox();
    for (const position of [0, draft.length]) {
      await typingEvent(gateway, { sessionKey, preview: draft, cursor: position });
      await expect.poll(async () => (await caretPrefix(preview)).length).toBe(position);
      const box = await caret.boundingBox();
      const previewBox = await preview.boundingBox();
      expect(previewBox?.height).toBe(initialPreview?.height);
      expect(box?.x).toBeCloseTo(previewBox!.x, 0);
      if (position === 0) {
        expect(box?.y).toBe(firstLine?.y);
      } else {
        // Five explicit line breaks put the terminal caret on the sixth line.
        const lineHeight = await preview.evaluate((element) =>
          Number.parseFloat(getComputedStyle(element).lineHeight),
        );
        expect(box!.y - firstLine!.y).toBeCloseTo(5 * lineHeight, 0);
      }
    }
  });

  it("aligns the watched caret with text across text sizes and paragraph boundaries", async () => {
    const { page, gateway } = await openSuggestions("owner");
    await page.clock.install();
    await pauseVirtualClock(page);
    const preview = page.locator(".agent-chat__typing-preview-text");
    const draft = "Text in progress.\n\nSecond paragraph.\n";
    for (const scale of [0.9, 1, 1.1, 1.25, 1.4]) {
      await page.evaluate((value) => {
        document.documentElement.style.setProperty("--control-ui-text-scale", String(value));
      }, scale);
      for (const cursor of [
        0,
        1,
        draft.indexOf("\n"),
        draft.indexOf("\n") + 1,
        draft.indexOf("Second"),
        draft.length,
      ]) {
        await typingEvent(gateway, { preview: draft, cursor });
        await expect.poll(() => caretPrefix(preview)).toBe(draft.slice(0, cursor));
        await preview.evaluate(() => document.fonts.ready);
        const geometry = await caretTextGeometry(preview);
        const line = draft.slice(0, cursor).split("\n").length - 1;
        expect(geometry.height).toBeCloseTo(geometry.textHeight, 1);
        expect(geometry.top).toBeCloseTo(geometry.textTop + line * geometry.lineHeight, 1);
      }
    }
    for (const empty of ["", "\n\n"]) {
      await typingEvent(gateway, { preview: empty, cursor: 0 });
      await expect(preview).toHaveCount(0);
      await expect(page.locator(".agent-chat__typing-bubble > span")).toHaveCount(3);
    }
  });

  it("submits a viewer draft as a suggestion and shows its pending state", async () => {
    const suggestion = pendingSuggestion("suggestion-1", "Try the focused change", 1);
    const { page, gateway, composer } = await openSuggestions("viewer", {
      methodResponses: {
        "session.suggestions.add": { suggestion },
        "session.typing": { ok: true, broadcast: true },
      },
    });
    const modelTrigger = page.locator(".chat-controls__model-trigger");
    const typingRow = page.locator('[data-virtual-row-key="presence:typing"]');
    const typingIndicator = typingRow.locator(".agent-chat__typing-indicator");
    await modelTrigger.waitFor();
    const idleModelBox = await bounds(modelTrigger);
    await expect(typingIndicator).toHaveCount(0);
    await typingEvent(gateway);
    await expect(typingIndicator.locator(".sr-only")).toHaveText("Owner is typing…");
    const [typingModelBox, typingRowBox, composerShellBox] = await Promise.all([
      bounds(modelTrigger),
      bounds(typingRow),
      bounds(page.locator(".agent-chat__composer-shell")),
    ]);
    expect(Math.abs(typingModelBox.x - idleModelBox.x)).toBeLessThanOrEqual(0.5);
    // The #122809 regression shifted the picker by a full indicator row
    // (~20px); allow subpixel/rounding jitter seen on CI renderers (2.41px).
    expect(Math.abs(typingModelBox.y - idleModelBox.y)).toBeLessThanOrEqual(4);
    expect(typingRowBox.y + typingRowBox.height).toBeLessThanOrEqual(composerShellBox.y + 1);
    await gateway.emitGatewayEvent("session.message", {
      sessionKey: "main",
      agentId: "main",
      message: ownerMessage("Owner finished typing"),
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
  });

  it("does not offer live-session commands in a viewer suggestion composer", async () => {
    const { page, gateway, composer } = await openSuggestions("viewer", {
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
      },
    });
    await composer.fill("Keep this /sta");
    await gateway.waitForRequest("commands.list");
    await expect(page.getByRole("option", { name: /\/status/u })).toHaveCount(0);
    await composer.fill("/bt");
    await page.getByRole("option").filter({ hasText: "/btw" }).click();
    expect(await gateway.getRequests("session.suggestions.add")).toHaveLength(0);
    await expect(composer).toHaveValue("/btw ");
    expect(await gateway.getRequests("chat.send")).toHaveLength(0);
  });

  it.each(["direct", "group"] as const)(
    "streams a remote draft into a live preview bubble (%s)",
    async (kind) => {
      const { page, gateway } = await openSuggestions(
        "viewer",
        {
          presenceUsers: [
            { ...presenceUser("alice", true), identity: { type: "profile", id: "alice" } },
            presenceUser("owner"),
            presenceUser("zoe"),
          ],
          sessions: sessionRow("viewer", kind).sessions,
          methodResponses: { "session.typing": { ok: true, broadcast: true } },
        },
        kind,
      );
      const typingRow = page.locator('[data-virtual-row-key="presence:typing"]');
      const previewBubble = typingRow.locator(".agent-chat__typing-preview-text");

      await page.clock.install();
      const ownerTyping = (preview?: string) => typingEvent(gateway, preview ? { preview } : {});

      await ownerTyping();
      await expect(typingRow.locator(".agent-chat__typing-bubble > span")).toHaveCount(3);
      await expect(previewBubble).toHaveCount(0);
      const typingAvatar = typingRow.locator(
        ".chat-message-avatar-anchor > :is(.chat-avatar, .chat-avatar-slot)",
      );
      await expect(typingAvatar).toBeVisible();
      await expect(typingAvatar).toHaveCSS("position", "absolute");

      const draft = "yea, cool. Live drafts stream into the bubble now.";
      let visible = "";
      for (const word of draft.split(" ")) {
        visible = visible ? `${visible} ${word}` : word;
        await ownerTyping(visible);
        await expect(previewBubble).toHaveText(visible);
      }
      await expect(typingRow.locator(".agent-chat__typing-preview-label")).toHaveText("Owner");
      await expect(typingRow.locator(".agent-chat__typing-state")).toHaveText("is typing...");
      await expect(typingRow.locator(".agent-chat__typing-bubble")).toHaveCount(0);
      const activeBox = await previewBubble.boundingBox();
      await page.clock.runFor(10_000);
      await expect(previewBubble).toHaveText(draft);
      await expect(typingRow.locator(".agent-chat__typing-state")).toHaveText("Draft");
      await expect(typingRow.locator(".sr-only")).toBeEmpty();
      expect(await previewBubble.boundingBox()).toEqual(activeBox);
      expect(await afterAnimation(previewBubble)).toBe("none");

      await typingEvent(gateway, {
        actor: { type: "human", id: "zoe", label: "Zoe" },
      });
      await ownerTyping(draft);
      await expect(typingRow.locator(".agent-chat__typing-bubble > span")).toHaveCount(3);
      await expect(previewBubble).toHaveText(draft);
      const status = typingRow.locator(".sr-only");
      await expect(status).toHaveText("Owner, Zoe are typing…");
      await expect(status).not.toContainText("yea, cool");

      await typingEvent(gateway, {
        actor: { type: "human", id: "zoe", label: "Zoe" },
        typing: false,
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
      }
      await page.emulateMedia({ reducedMotion: "reduce" });
      await ownerTyping("مسودة لم ترسل بعد 👋");
      await expect(previewBubble).toHaveCSS("direction", "rtl");
      expect(await afterAnimation(previewBubble)).toBe("none");
      await page.setViewportSize({ width: 1180, height: 760 });
      await page.evaluate(() => {
        document.documentElement.dataset.theme = "light";
        document.documentElement.dataset.themeMode = "light";
      });
      await ownerTyping(draft);
      await expect(previewBubble).toHaveText(draft);
      await waitForLayoutSettled(page, '[data-virtual-row-key="presence:typing"] .chat-group');
      const beforeSend = await bubbleGeometry(previewBubble);
      await gateway.emitGatewayEvent("session.message", {
        sessionKey: "main",
        sessionId: "session-main",
        agentId: "main",
        message: {
          ...ownerMessage(draft, { id: "sent-owner-draft" }),
          timestamp: Date.now(),
        },
      });
      await expect(typingRow).toHaveCount(0);
      const sentText = page.locator(".chat-group--peer .chat-text").filter({ hasText: draft });
      await expect(sentText).toHaveCount(1);
      await waitForLayoutSettled(page, ".chat-group--peer .chat-text");
      const afterSend = await bubbleGeometry(sentText);
      expect(afterSend).toMatchObject({
        padding: beforeSend.padding,
        radius: beforeSend.radius,
        font: beforeSend.font,
      });
      expect(afterSend.x).toBeCloseTo(beforeSend.x, 0);
      expect(afterSend.y).toBeCloseTo(beforeSend.y, 0);
      expect(afterSend.background).not.toBe(beforeSend.background);
      await ownerTyping("Another unsent draft");
      await expect(previewBubble).toHaveText("Another unsent draft");
      await page.clock.runFor(10_000);
      await expect(typingRow.locator(".agent-chat__typing-state")).toHaveText("Draft");
      await gateway.emitGatewayEvent("presence", {
        presence: ["alice", "owner", "zoe"].map((id) => ({
          ts: Date.now(),
          user: { id, identity: { type: "profile", id } },
          watchedSessions: id === "owner" ? ["agent:main:other"] : [sessionKey],
        })),
      });
      await expect(typingRow).toHaveCount(0);
    },
  );

  it("loads an owner edit without replacing a newer composer draft", async () => {
    const suggestion = pendingSuggestion("suggestion-2", "Please edit this first", 2);
    const { page, gateway, composer } = await openSuggestions("owner", {
      deferredMethods: ["session.suggestions.resolve"],
      presenceUsers: [presenceUser("owner", true), presenceUser("alice")],
      methodResponses: {
        "session.suggestions.list": { suggestions: [suggestion], role: "owner" },
      },
    });

    const row = page.locator(".session-suggestion");
    await expect(row).toBeVisible();
    await page.getByRole("button", { name: "Edit Alice's suggestion" }).click();
    await gateway.waitForRequest("session.suggestions.resolve");
    await expect(composer).toHaveValue("Please edit this first");
    await composer.fill("A newer owner draft");
    await gateway.resolveDeferred("session.suggestions.resolve", {
      suggestion: { ...suggestion, state: "accepted" },
    });
    await expect(composer).toHaveValue("A newer owner draft");
  });

  it.each(["one identity", "unadvertised suggestion RPCs"] as const)(
    "keeps the suggestion composer read-only with %s",
    async (reason) => {
      const page = await newPage();
      const solo = reason === "one identity";
      const gateway = await installMockGateway(page, {
        ...(solo ? { featureMethods } : {}),
        presenceUsers: solo
          ? [presenceUser("alice", true)]
          : [presenceUser("alice", true, ["main"]), presenceUser("owner", false, ["main"])],
        methodResponses: { "sessions.list": sessionRow("viewer") },
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await expect(page.locator(".agent-chat__composer-combobox textarea")).toBeDisabled();
      await expect(page.getByRole("button", { name: "Suggest message" })).toHaveCount(0);
      if (solo) {
        await expect(page.locator(".agent-chat__typing-indicator")).toHaveCount(0);
        expect(await gateway.getRequests("session.suggestions.list")).toEqual([]);
      }
    },
  );
});
