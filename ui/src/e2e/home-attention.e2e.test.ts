import photon from "@silvia-odwyer/photon-node";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { createPlaybackMediaFixture } from "../../../test/fixtures/media-playback.js";
import type { AgentsListResult } from "../api/types.ts";
import { CHAT_RUN_ACTIVITY_CHANGED_EVENT } from "../pages/chat/chat-history-events.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { requireRecord, requireString } from "./chat-flow.test-support.ts";
import { computedStyles as styles } from "./config-composer-fixtures.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { expectStyles } from "./style-contract.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI chat shell regressions",
  startServerBeforeBrowser: true,
  trackBrowserContexts: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const mainSessionKey = "agent:main:main";

const initialName = "Atlas";
const nextName = "Cedar";
const initialAvatar = "🦞";
const nextAvatar = "🌻";
const draft = "Keep this unsent garden note.";
const reply = "The garden note stayed in this chat.";

const identity = (name: string, avatar: string) => ({
  agentId: "main",
  name,
  avatar,
  avatarStatus: "none",
  nameSource: "agent",
});

const roster = (name: string, avatar: string): AgentsListResult => ({
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
  agents: [
    { id: "main", name, identity: { name, emoji: avatar }, model: { primary: "openai/gpt-5.5" } },
  ],
});

const scrollTo = (scroller: Locator, fraction: number) =>
  scroller.evaluate((el, ratio) => {
    el.scrollTop = (el.scrollHeight - el.clientHeight) * ratio;
  }, fraction);

// Sample real mask pixels: correct observer attributes do not rule out a hard clip.
async function expectClearEdge(scroller: Locator) {
  const page = scroller.page();
  await scroller.evaluate((element) => {
    element.setAttribute("data-fade-probe", "");
    element.parentElement!.setAttribute("data-fade-probe-parent", "");
  });
  const probe = await page.addStyleTag({
    content:
      "[data-fade-probe] { background: white !important; } [data-fade-probe] > * { visibility: hidden !important; } [data-fade-probe-parent] { background: black !important; }",
  });
  let image: ReturnType<typeof photon.PhotonImage.new_from_byteslice> | undefined;
  try {
    image = photon.PhotonImage.new_from_byteslice(
      await scroller.screenshot({ animations: "disabled" }),
    );
    const width = image.get_width();
    const height = image.get_height();
    const pixels = image.get_raw_pixels();
    const sample = (y: number) => pixels[(y * width + Math.floor(width / 2)) * 4]!;
    // Skip the rounded outer pixel, which can include the parent border.
    for (const edge of ["top", "bottom"]) {
      const ramp = Array.from({ length: 36 }, (_, y) =>
        sample(edge === "top" ? y + 1 : height - 2 - y),
      );
      expect(ramp[0], `${edge}: content clears the clipping boundary`).toBeLessThanOrEqual(3);
      expect(ramp[4], `${edge}: no bright strip at the edge`).toBeLessThan(30);
      expect(ramp[35], `${edge}: interior stays fully legible`).toBeGreaterThanOrEqual(250);
      const steps = ramp.slice(1).map((value, index) => value - ramp[index]!);
      expect(Math.min(...steps), `${edge}: no reverse`).toBeGreaterThanOrEqual(-1);
      expect(Math.max(...steps), `${edge}: no abrupt opacity jump`).toBeLessThan(25);
    }
  } finally {
    image?.free();
    await probe.evaluate((el) => el.parentNode?.removeChild(el));
    await scroller.evaluate((el) => {
      el.removeAttribute("data-fade-probe");
      el.parentElement!.removeAttribute("data-fade-probe-parent");
    });
  }
}

function attachment(kind: string, label: string, mimeType: string) {
  return {
    type: "attachment",
    attachment: { kind, label, mimeType, url: new URL(label, suite.server.baseUrl).href },
  };
}
suite.define(() => {
  it.each(["config.changed", "agent.identity.changed"])("%s refreshes chat", async (event) => {
    const context = await suite.newBrowserContext({
      ...createControlUiE2eContextOptions(),
      locale: "en-US",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    try {
      const gateway = await installMockGateway(page, {
        assistantName: initialName,
        historyMessages: [],
        communityInvite: false,
        methodResponses: {
          "agent.identity.get": identity(initialName, initialAvatar),
          "agents.list": roster(initialName, initialAvatar),
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "main"));
      const heading = page.locator(".agent-chat__welcome-identity h2");
      const avatar = page.locator(".agent-chat__welcome-avatar");
      const avatarText = avatar.locator(".identity-avatar__text");
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await expect.poll(() => heading.textContent()).toBe(initialName);
      await expect.poll(() => avatarText.getAttribute("data-avatar")).toBe(initialAvatar);
      await expect.poll(() => composer.getAttribute("placeholder")).toContain(initialName);
      await composer.fill(draft);
      const sessionUrl = page.url();
      expect(await page.locator(".chat-group").count()).toBe(0);

      const refreshes = [];
      for (const [method, response] of [
        ["agent.identity.get", identity(nextName, nextAvatar)],
        ["agents.list", roster(nextName, nextAvatar)],
      ] as const) {
        refreshes.push({ method, after: (await gateway.getRequests(method)).length });
        await gateway.setMethodResponse(method, response);
      }

      await gateway.emitGatewayEvent(
        event,
        event === "config.changed" ? { hash: "synthetic-identity-change" } : { agentId: "main" },
      );
      for (const refresh of refreshes) {
        await gateway.waitForRequest(refresh.method, { after: refresh.after });
      }
      await expect.poll(() => heading.textContent()).toBe(nextName);
      await expect.poll(() => avatarText.getAttribute("data-avatar")).toBe(nextAvatar);
      await expect.poll(() => page.title()).toContain(nextName);
      const observed = {
        name: (await heading.textContent())?.trim(),
        avatar: await avatarText.getAttribute("data-avatar"),
        avatarLabel: await avatar.getAttribute("aria-label"),
        placeholder: await composer.getAttribute("placeholder"),
      };
      expect(await composer.inputValue()).toBe(draft);
      expect(page.url()).toBe(sessionUrl);
      expect(await page.locator(".chat-group").count()).toBe(0);
      expect((await gateway.getRequests("chat.send")).length).toBe(0);

      await page.getByRole("button", { name: "Send message" }).click();
      const request = await gateway.waitForRequest("chat.send");
      const params = requireRecord(request.params);
      expect(params).toMatchObject({ sessionKey: "agent:main:main", message: draft });
      const runId = requireString(params.idempotencyKey, "chat run id");
      await gateway.emitChatFinal({ runId, text: reply });
      await page.locator(".chat-group.assistant .chat-text", { hasText: reply }).waitFor();
      const sender = (
        await page.locator(".chat-group.assistant .chat-sender-name").first().textContent()
      )?.trim();
      expect(page.url()).toBe(sessionUrl);
      expect((await gateway.getRequests("chat.send")).length).toBe(1);
      expect({ ...observed, sender }, "config identity display follows committed identity").toEqual(
        {
          name: nextName,
          avatar: nextAvatar,
          avatarLabel: nextName,
          placeholder: "Message Cedar",
          sender: nextName,
        },
      );
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("does not republish run activity for successive text deltas", async () =>
    suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, { sessionKey: mainSessionKey });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, mainSessionKey));
      await page.locator(".agent-chat__composer-combobox textarea").fill("Draft report.");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      const send = await gateway.waitForRequest("chat.send");
      const runId = requireString(requireRecord(send.params).idempotencyKey, "chat run id");
      const emitDelta = (text: string) =>
        gateway.emitGatewayEvent("chat", {
          state: "delta",
          runId,
          sessionKey: mainSessionKey,
          message: { role: "assistant", content: [{ type: "text", text }] },
        });
      await emitDelta("Preparing.");
      const activity = await page.evaluateHandle((eventName) => {
        const observation = { changes: 0 };
        document.addEventListener(eventName, () => observation.changes++);
        return observation;
      }, CHAT_RUN_ACTIVITY_CHANGED_EVENT);
      await emitDelta("Preparing. Checking.");
      await page.getByText("Preparing. Checking.", { exact: true }).waitFor();
      expect(await activity.evaluate((observation) => observation.changes)).toBe(0);
    }));

  it.each([390, 1280])("preserves scroll endpoints and controls at %ipx", (width) =>
    suite.withPage(
      { viewport: { width, height: 800 }, colorScheme: "dark", reducedMotion: "reduce" },
      async ({ page }) => {
        const key = "agent:main:dashboard:fade-proof";
        const gateway = await installMockGateway(page, {
          sessionKey: key,
          sessions: Array.from({ length: 40 }, (_, i) => ({
            key: i === 0 ? key : `agent:main:dashboard:proof-${i}`,
            label: i === 0 ? "Review overflow fades" : `Design review ${i}`,
            kind: "direct",
            updatedAt: 40 - i,
          })),
          historyMessages: [{ role: "assistant", content: "Review the overflow edges." }],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.waitFor();
        if (width > 768) {
          // Expand the capped list so the compact header still leaves a real scroll range.
          await page.getByRole("button", { name: "Show more", exact: true }).click();
          await page.setViewportSize({ width, height: 500 });
          const sidebar = page.locator(".sidebar-shell__body");
          await expect.poll(() => sidebar.getAttribute("class")).toContain("scroll-top");
          await scrollTo(sidebar, 0.5);
          await expect.poll(() => sidebar.getAttribute("class")).toContain("scroll-middle");
          await expectClearEdge(sidebar);
          await scrollTo(sidebar, 1);
          await expect.poll(() => sidebar.getAttribute("class")).toContain("scroll-bottom");
          await page.setViewportSize({ width, height: 800 });
        }
        await gateway.setOnline(false);
        await gateway.closeLatest();
        for (let i = 1; i <= 7; i++) {
          await composer.fill(`Review item ${i}: verify smooth edges and readable content`);
          await composer.press("Enter");
          await page.locator(".chat-queue__item", { hasText: `Review item ${i}:` }).waitFor();
        }
        const queue = page.locator(".chat-queue__scroll");
        await expect.poll(() => queue.getAttribute("data-scrollable")).toBe("true");
        await scrollTo(queue, 0.5);
        await expect.poll(() => queue.getAttribute("data-at-start")).toBe("false");
        await expect.poll(() => queue.getAttribute("data-at-end")).toBe("false");
        await expectClearEdge(queue);
        await scrollTo(queue, 1);
        await expect.poll(() => queue.getAttribute("data-at-end")).toBe("true");
        const last = queue.locator(".chat-queue__item").last().locator(".chat-queue__grip");
        await last.focus();
        expect(await last.evaluate((el) => el.matches(":focus"))).toBe(true);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        ).toBe(true);
      },
    ),
  );

  it("preserves large, preview, and unavailable file visuals in both themes", async () =>
    suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      await page.route("**/style-proof.mp3", (route) =>
        route.fulfill({ contentType: "audio/mpeg", body: createPlaybackMediaFixture("mp3") }),
      );
      await installMockGateway(page, {
        historyMessages: [
          {
            role: "assistant",
            content: [
              attachment("document", "report.pdf", "application/pdf"),
              attachment("audio", "style-proof.mp3", "audio/mpeg"),
              {
                type: "attachment_error",
                attachment: { code: "file-not-found", kind: "document", label: "missing.pdf" },
              },
            ],
            timestamp: 1,
          },
        ],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const compact = page.locator(
        '.chat-assistant-attachment-card--audio .chat-attachment-file-icon[data-mode="preview-with-favicon"]',
      );
      await compact.waitFor({ state: "visible" });
      const documentCard = page.locator(".chat-assistant-attachment-card--compact", {
        hasText: "report.pdf",
      });
      const unavailable = page.locator(".chat-assistant-attachment-card--definitive", {
        hasText: "missing.pdf",
      });
      await unavailable.waitFor({ state: "visible" });

      for (const theme of ["dark", "light"]) {
        await page.evaluate((mode) => {
          document.documentElement.dataset.themeMode = mode;
        }, theme);
        const large = documentCard.locator(".chat-attachment-file-icon");
        await expectStyles(large, {
          width: "44px",
          height: "44px",
          "background-image": expect.stringContaining(`large/shell-${theme}.svg`),
        });
        const glyph = await styles(large.locator(".chat-attachment-file-icon__overlay"), [
          "width",
          "height",
          "mask-image",
          "-webkit-mask-image",
        ]);
        expect(glyph).toEqual({
          width: "14px",
          height: "14px",
          "mask-image": expect.stringContaining("overlays/pdf.svg"),
          "-webkit-mask-image": glyph["mask-image"],
        });
        await expectStyles(compact, {
          width: "20px",
          height: "20px",
          "background-image": expect.stringContaining(`compact/${theme}/mp3.svg`),
        });
        await expectStyles(documentCard, { display: "block", padding: "0px" });
        const danger = await unavailable.evaluate((card) => {
          const sample = document.createElement("span");
          sample.style.color = getComputedStyle(card).getPropertyValue("--danger").trim();
          document.body.append(sample);
          const resolved = getComputedStyle(sample).color;
          sample.remove();
          return resolved;
        });
        await expectStyles(unavailable, { display: "block", padding: "0px" });
        await expectStyles(unavailable.locator(".chat-attachment-file-icon"), {
          opacity: "0.42",
        });
        await expectStyles(unavailable.locator(".chat-assistant-attachment-card__status-badge"), {
          color: danger,
        });
        await expectStyles(unavailable.locator(".chat-assistant-attachment-card__title"), {
          "text-decoration-line": "none",
          "white-space": "nowrap",
        });
      }
    }));
});
