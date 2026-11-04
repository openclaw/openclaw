import { writeFile } from "node:fs/promises";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import type { MentionInboxItem } from "../../../packages/gateway-protocol/src/schema/human-mentions.js";
import type { GatewaySessionRow } from "../api/types.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import {
  takeControlUiScreenshotFrame,
  waitForControlUiProofSurface,
} from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { createPageOpener } from "./new-session-page.scenario.test-support.ts";
import { themeConfigResponse } from "./theme-typography.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Welcome personal recent chats" });
const openPage = createPageOpener(suite);
const actor = (id: string) => ({
  type: "human" as const,
  id,
  identity: { type: "profile" as const, id },
});
const row = (id: string, label: string, recency: number) =>
  ({
    key: "agent:main:dashboard:" + id,
    sessionId: id,
    kind: "direct",
    label,
    updatedAt: Date.now() - (2000 - recency) * 60_000,
    lastInteractionAt: Date.now() - (2000 - recency) * 60_000,
  }) satisfies GatewaySessionRow;
const result = (sessions: GatewaySessionRow[]) => ({
  ts: Date.now(),
  path: "",
  count: sessions.length,
  defaults: { contextTokens: null, model: null, modelProvider: null },
  sessions,
});

suite.define(() => {
  it.each([
    { viewer: "alice", surface: "new" },
    { viewer: "bob", surface: "new" },
  ])(
    "shows $viewer’s Gateway involvement on $surface without narrowing discovery",
    async ({ viewer, surface }) => {
      const page = await openPage({ viewport: { width: 1280, height: 900 } });
      const other = viewer === "alice" ? "bob" : "alice";
      const ownTitle = viewer === "alice" ? "Alice’s planning notes" : "Bob’s planning notes";
      const owned = { ...row(viewer + "-owned", ownTitle, 30), owner: { actor: actor(viewer) } };
      const prompted = {
        ...row("shared", "Shared release planning", 20),
        owner: { actor: actor(other) },
      };
      // Prompt/mention evidence is Gateway-owned, not the bounded browser participant preview.
      const mentioned = {
        ...row("mentioned", "Design review mention", 10),
        owner: { actor: actor(other) },
      };
      const personal = [owned, prompted, mentioned];
      const team = Array.from({ length: 300 }, (_, i) => ({
        ...row("team-" + i, "Team conversation " + i, 1000 - i),
        owner: { actor: actor(other) },
      }));
      const hidden = {
        ...row("hidden", "Personally hidden conversation", 2000),
        hiddenFromInvolvingMe: true,
      };
      const broadPage = [hidden, ...team.slice(0, 299)];
      const gateway = await installMockGateway(page, {
        hasMultipleSessionSharingIdentities: true,
        presenceUsers: [
          { self: true, id: viewer, identity: { type: "profile", id: viewer }, name: viewer },
        ],
        sessions: [...team, ...personal, hidden],
        historyMessages: [],
        methodResponses: {
          "sessions.list": {
            cases: [
              { match: { involvingMe: true }, response: result(personal) },
              { response: { ...result(broadPage), hasMore: true, nextOffset: 300 } },
            ],
          },
        },
      });
      await page.goto(
        surface === "new"
          ? suite.server.baseUrl + "new"
          : controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"),
      );
      const names = page.locator(".agent-chat__recent-name");
      await expect.poll(() => names.count()).toBeGreaterThan(0);
      await expect
        .poll(() => names.allTextContents())
        .toEqual([ownTitle, "Shared release planning", "Design review mention"]);
      const requests = await gateway.getRequests("sessions.list");
      expect(
        requests.some((request) => {
          const params = asOptionalRecord(request.params);
          return params?.involvingMe === true && params.agentId === "main";
        }),
      ).toBe(true);
      // The primary roster remains broad: personal rows lie beyond its first page.
      expect(
        requests.some((request) => asOptionalRecord(request.params)?.involvingMe !== true),
      ).toBe(true);
    },
  );

  it.each(["new"])("renders tightly aligned unread-first session rows on %s", async (surface) => {
    const page = await openPage({ viewport: { width: 1280, height: 900 }, colorScheme: "dark" });
    const now = Date.now();
    const session = (id: string, label: string, minutes: number, unread: boolean) => ({
      ...row(id, label, 100),
      updatedAt: now - minutes * 60_000,
      lastInteractionAt: now - minutes * 60_000,
      unread,
    });
    const release = session("release", "Release checklist", 6, true);
    const review = session("review", "Review new session layout", 38, true);
    const personal = session("personal", "Personal recent sessions", 2, false);
    const onboarding = session("onboarding", "Improve onboarding", 22, false);
    const performance = session("performance", "Chat performance", 60, false);
    const ordered = [release, review, personal, onboarding, performance];
    const recency = [personal, release, onboarding, review, performance];
    const mentions: MentionInboxItem[] = [
      {
        id: "review-mention",
        senderProfileId: "maya",
        senderLabel: "Maya",
        senderAvatarUrl: "/api/users/maya/avatar?v=1",
        sessionKey: review.key,
        agentId: "main",
        sessionTitle: review.label,
        messageId: "review-message",
        createdAt: now - 38 * 60_000,
        expiresAt: now + 3_600_000,
      },
      {
        id: "performance-mention",
        senderProfileId: "noah",
        senderLabel: "Noah",
        senderAvatarUrl: "/api/users/noah/avatar?v=1",
        sessionKey: performance.key,
        agentId: "main",
        sessionTitle: performance.label,
        messageId: "performance-message",
        createdAt: now - 60 * 60_000,
        expiresAt: now + 3_600_000,
      },
    ];
    await page.route("**/api/users/{maya,noah}/avatar*", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body:
          '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="16" fill="seagreen"/><text x="16" y="22" text-anchor="middle" fill="white" font-family="sans-serif" font-size="18">' +
          (route.request().url().includes("maya") ? "M" : "N") +
          "</text></svg>",
      }),
    );
    const gateway = await installMockGateway(page, {
      hasMultipleSessionSharingIdentities: true,
      presenceUsers: [
        { self: true, id: "alice", name: "Alice", identity: { type: "profile", id: "alice" } },
      ],
      featureMethods: [...defaultControlUiFeatureMethods, "mentions.list", "mentions.dismiss"],
      sessions: ordered,
      historyMessages: [],
      methodResponses: {
        "config.get": themeConfigResponse("absolutely", "dark"),
        "mentions.list": { gatewayInstanceId: "e2e-gateway-boot", revision: 1, items: mentions },
        "sessions.list": {
          cases: [
            {
              match: {
                involvingMe: true,
                sortBy: "unread",
                excludeSnoozed: true,
                requireLastInteraction: true,
              },
              response: result(ordered),
            },
            { response: result(recency) },
          ],
        },
      },
    });
    await page.addInitScript((key) => {
      localStorage.setItem(key, JSON.stringify({ theme: "absolutely", themeMode: "dark" }));
    }, controlUiBundledSettingsStorageKey(suite.server.baseUrl));
    await page.goto(
      surface === "new"
        ? suite.server.baseUrl + "new"
        : controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"),
    );
    const names = page.locator(".agent-chat__recent-name");
    await expect.poll(() => names.count()).toBe(5);
    await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("absolutely");
    if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
      await waitForControlUiProofSurface(page.locator(".agent-chat__welcome-secondary"), [
        names.first(),
      ]);
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF_STAGE !== "before") {
        await expect.poll(() => page.locator(".agent-chat__recent-mention").count()).toBe(2);
      }
      const frame = await takeControlUiScreenshotFrame(page, names.first(), [names.first()], {
        animations: "disabled",
      });
      const destination = path.join(suite.artifactDir, "compact-" + surface + ".png");
      await writeFile(destination, frame.png);
      console.log("Compact welcome proof: " + destination);
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF_STAGE === "before") {
        await page.setViewportSize({ width: 800, height: 900 });
        const narrow = await takeControlUiScreenshotFrame(page, names.first(), [names.first()], {
          animations: "disabled",
        });
        const narrowDestination = path.join(
          suite.artifactDir,
          "compact-narrow-" + surface + ".png",
        );
        await writeFile(narrowDestination, narrow.png);
        console.log("Compact narrow welcome proof: " + narrowDestination);
        await page.setViewportSize({ width: 1280, height: 900 });
      }
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF_STAGE === "before") {
        return;
      }
    }
    await expect.poll(() => names.allTextContents()).toEqual(ordered.map((entry) => entry.label));
    await expect.poll(() => page.locator(".agent-chat__recent-mention").count()).toBe(2);
    expect(await page.locator(".agent-chat__recent-mention").allTextContents()).toEqual([
      "Maya mentioned you",
      "Noah mentioned you",
    ]);
    expect(
      await page.locator(".agent-chat__recent-mention img, .agent-chat__recent-mention a").count(),
    ).toBe(0);
    expect(await page.locator(".agent-chat__recents-title").textContent()).toBe("Recent sessions");
    expect(await page.locator(".agent-chat__recent-sub").count()).toBe(0);
    for (const mode of ["dark", "light"] as const) {
      await evaluateControlUiContext(page, (context, value) => context.theme.setMode(value), mode);
      await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe(mode);
      const facts = await page.locator(".agent-chat__recent-item").evaluateAll((items) => {
        const token = (name: string) => {
          const probe = document.createElement("span");
          probe.style.color = "var(" + name + ")";
          document.body.append(probe);
          const color = getComputedStyle(probe).color;
          probe.remove();
          return color;
        };
        return items.map((item) => {
          const title = item.querySelector<HTMLElement>(".agent-chat__recent-name")!;
          const time = item.querySelector<HTMLElement>(".agent-chat__recent-time")!;
          const dot = item.querySelector<HTMLElement>(".agent-chat__recent-dot")!;
          const mention = item.querySelector<HTMLElement>(".agent-chat__recent-mention");
          return {
            titleColor: getComputedStyle(title).color,
            weight: getComputedStyle(title).fontWeight,
            dot: getComputedStyle(dot).visibility,
            dotColor: getComputedStyle(dot).backgroundColor,
            titleTop: title.getBoundingClientRect().top,
            timeTop: time.getBoundingClientRect().top,
            timeColor: getComputedStyle(time).color,
            timeRight: time.getBoundingClientRect().right,
            mentionInside:
              !mention || item.querySelector(".agent-chat__recent-content")!.contains(mention),
            senderColor: mention ? getComputedStyle(mention).color : null,
            fontSize: getComputedStyle(title).fontSize,
            lineHeight: getComputedStyle(title).lineHeight,
            rowHeight: item.getBoundingClientRect().height,
            titleLeft: title.getBoundingClientRect().left,
            mentionLeft: mention?.getBoundingClientRect().left,
            gap: mention
              ? mention.getBoundingClientRect().top - title.getBoundingClientRect().bottom
              : null,
            dotOffset: dot.getBoundingClientRect().top + 3 - title.getBoundingClientRect().top - 10,
            strong: token("--text-strong"),
            text: token("--text"),
            muted: token("--muted"),
            accent: token("--accent"),
          };
        });
      });
      for (const [i, fact] of facts.entries()) {
        expect(fact.weight).toBe("500");
        expect(fact.fontSize).toBe("14px");
        expect(fact.lineHeight).toBe("20px");
        expect(fact.rowHeight).toBe(fact.senderColor ? 54 : 36);
        expect(Math.abs(fact.dotOffset)).toBeLessThanOrEqual(1);
        expect(fact.titleColor).toBe(i < 2 ? fact.strong : fact.text);
        expect(fact.dot).toBe(i < 2 ? "visible" : "hidden");
        expect(fact.dotColor).toBe(fact.accent);
        expect(fact.timeColor).toBe(fact.muted);
        expect(Math.abs(fact.titleTop - fact.timeTop)).toBeLessThanOrEqual(1);
        expect(fact.mentionInside).toBe(true);
        if (fact.senderColor) {
          expect(fact.senderColor).toBe(fact.muted);
          expect(fact.gap).toBe(2);
          expect(fact.mentionLeft).toBe(fact.titleLeft);
        }
      }
      expect(new Set(facts.map((fact) => Math.round(fact.timeRight))).size).toBe(1);
      const [composer, recents] = await Promise.all(
        [".new-session-page__message", ".agent-chat__recents"].map((selector) =>
          page.locator(selector).evaluate((el) => {
            const box = el.getBoundingClientRect();
            return { center: box.left + box.width / 2, width: box.width };
          }),
        ),
      );
      // Recents form a narrower column centered under the composer.
      expect(recents!.width).toBe(560);
      expect(recents!.width).toBeLessThan(composer!.width);
      expect(Math.abs(recents!.center - composer!.center)).toBeLessThanOrEqual(1);
    }
    await page.setViewportSize({ width: 800, height: 900 });
    const layout = await page.locator(".agent-chat__recents").evaluate((element) => ({
      overflow: element.scrollWidth > element.clientWidth,
      right: element.getBoundingClientRect().right,
      viewport: innerWidth,
    }));
    expect(layout.overflow).toBe(false);
    expect(layout.right).toBeLessThanOrEqual(layout.viewport);
    if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
      await evaluateControlUiContext(page, (context) => context.theme.setMode("dark"));
      await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("dark");
      const frame = await takeControlUiScreenshotFrame(page, names.first(), [names.first()], {
        animations: "disabled",
      });
      const destination = path.join(suite.artifactDir, "compact-narrow-" + surface + ".png");
      await writeFile(destination, frame.png);
      console.log("Compact narrow welcome proof: " + destination);
    }
    await gateway.setMethodResponse("mentions.list", {
      gatewayInstanceId: "e2e-gateway-boot",
      revision: 2,
      items: [],
    });
    await gateway.emitGatewayEvent("mentions.changed", {
      gatewayInstanceId: "e2e-gateway-boot",
      revision: 2,
    });
    await expect.poll(() => page.locator(".agent-chat__recent-mention").count()).toBe(0);
    expect(await names.allTextContents()).toEqual(ordered.map((entry) => entry.label));
    await gateway.setMethodResponse("sessions.list", result([]));
    await page.reload();
    await expect.poll(() => page.locator(".agent-chat__recent-name").count()).toBe(0);
    await expect.poll(() => page.locator(".agent-chat__suggestion").count()).toBe(4);
  });
});
