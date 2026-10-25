import { expect, it } from "vitest";
import type { SessionSnapshotStore } from "../pages/chat/session-snapshot-store.ts";
import { closeChatDetails, openChatTaskProgress } from "./chat-details.test-support.ts";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { installColdLoadTitleTrace } from "./cold-load-title.test-support.ts";

type ColdLoadFrame = {
  title?: string | null;
  top: number;
  max: number;
  duration: boolean;
  reply: boolean;
  progress: boolean;
  threadTop: number;
  threadHeight: number;
};
declare global {
  interface Window {
    coldLoadSamples?: ColdLoadFrame[];
    coldLoadCard?: Element | null;
    coldLoadRecording?: boolean;
    coldLoadReconcileStart?: number;
  }
}

const suite = createChatFlowE2eSuite();

function expectFrames(frames: ColdLoadFrame[], title: string, progress = true) {
  for (const frame of frames) {
    expect(frame.title).toBe(title);
    expect(Math.abs(frame.max - frame.top), JSON.stringify(frames)).toBeLessThanOrEqual(1);
    expect(frame).toMatchObject({
      duration: true,
      reply: true,
      ...(progress ? { progress: true } : {}),
    });
  }
}

suite.define(() => {
  it.each(["direct", "sidebar"])(
    "opens uncached history at the end on its first visible frame (%s)",
    async (navigation) => {
      await suite.withPage({ viewport: { width: 1200, height: 900 } }, async ({ page }) => {
        const sessionKey = "agent:main:dashboard:uncached-load";
        const sourceKey = "agent:main:dashboard:starting-conversation";
        const historyMessages = Array.from({ length: 40 }, (_, index) => ({
          role: index % 2 ? "assistant" : "user",
          content: "Synthetic message " + index + ": " + "Transcript detail. ".repeat(35),
          timestamp: 1_800_000_000_000 + index * 1000,
          __openclaw: { id: "uncached-" + index, seq: index + 1 },
        }));
        const responses = {
          cases: [
            {
              match: { sessionKey },
              response: {
                messages: historyMessages,
                sessionId: "uncached",
                hasMore: true,
                nextOffset: 40,
                totalMessages: 2040,
              },
            },
            {
              match: { sessionKey: sourceKey },
              response: {
                messages: [{ role: "assistant", content: "Starting conversation." }],
                sessionId: "starting",
              },
            },
          ],
        };
        const gateway = await installMockGateway(page, {
          sessionKey: navigation === "direct" ? sessionKey : sourceKey,
          methodResponses: {
            "chat.history": responses,
            "chat.startup": responses,
            "sessions.list": chatSessionListResponse([
              {
                key: sourceKey,
                sessionId: "starting",
                kind: "direct",
                label: "Starting conversation",
                updatedAt: 2,
              },
              {
                key: sessionKey,
                sessionId: "uncached",
                kind: "direct",
                label: "Unvisited conversation",
                updatedAt: 1,
              },
            ]),
          },
        });
        await page.addInitScript(() => {
          window.coldLoadSamples = [];
          const sample = () => {
            const thread = document.querySelector<HTMLElement>(
              ".chat-pane-cache__pane--active .chat-thread",
            );
            if (
              thread?.textContent?.includes("Synthetic message") &&
              thread.clientHeight > 0 &&
              getComputedStyle(thread.querySelector(".chat-thread-inner")!).visibility !== "hidden"
            ) {
              window.coldLoadSamples!.push({
                top: thread.scrollTop,
                max: thread.scrollHeight - thread.clientHeight,
                duration: false,
                reply: false,
                progress: false,
                threadTop: 0,
                threadHeight: thread.clientHeight,
              });
            }
            if (window.coldLoadSamples!.length < 24) {
              requestAnimationFrame(sample);
            }
          };
          requestAnimationFrame(sample);
        });
        if (navigation === "sidebar") {
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sourceKey));
          await page.getByText("Starting conversation.", { exact: true }).waitFor();
          await page
            .locator(
              '.sidebar-recent-session[data-session-key="' +
                sessionKey +
                '"] a.sidebar-recent-session__link',
            )
            .click();
        } else {
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        }
        await page.waitForFunction(() => (window.coldLoadSamples?.length ?? 0) >= 24);
        expect(await gateway.getRequests("chat.history", { offset: 40 })).toHaveLength(0);
        const frames = await page.evaluate(() => window.coldLoadSamples!);
        expect(frames[0]!.max).toBeGreaterThan(1000);
        expect(
          frames.every((frame) => Math.abs(frame.max - frame.top) <= 1),
          JSON.stringify(frames),
        ).toBe(true);
      });
    },
  );

  it("paints the cached tail, title, reply metadata, and progress before hello and reconciles in place", async () => {
    await suite.withPage(
      {
        viewport: { width: 1200, height: 900 },
        serviceWorkers: "block",
      },
      async ({ page }) => {
        const sessionKey = "agent:main:dashboard:cold-load";
        const runId = "cold-load-final-run";
        const session = {
          key: sessionKey,
          sessionId: "cold-load-session",
          kind: "direct" as const,
          label: "Synthetic cold-load conversation",
          boardFace: "chat" as const,
          hasActiveRun: false,
          status: "done" as const,
          lastRunId: runId,
          runtimeMs: 180_000,
          updatedAt: 1_800_000_180_000,
          participants: [
            { identity: { type: "profile" as const, id: "avery" }, label: "Avery" },
            { identity: { type: "profile" as const, id: "blake" }, label: "Blake" },
          ],
        };
        const progressCard = {
          sessionKey,
          revision: 2,
          updatedAt: session.updatedAt,
          markdown: "The synthetic report is ready for review.",
          steps: [{ step: "Review final report", status: "in_progress" }],
        };
        const historyMessages = [
          ...Array.from({ length: 38 }, (_, index) => ({
            __openclaw: { id: `cold-${index}`, seq: index + 1 },
            role: index % 2 ? "assistant" : "user",
            content: `Synthetic message ${index}: ${"Transcript detail. ".repeat(35)}`,
            timestamp: 1_800_000_000_000 + index * 1000,
          })),
          {
            role: "user",
            content: "Please review the synthetic report.",
            timestamp: 1_800_000_038_000,
            __openclaw: {
              id: "cold-38",
              seq: 39,
              runId,
              senderId: "avery",
              senderName: "Avery",
              senderIdentity: { type: "profile", id: "avery" },
            },
          },
          {
            role: "toolResult",
            toolName: "read",
            toolCallId: "cold-read",
            runId,
            content: "Synthetic report read.",
            timestamp: 1_800_000_039_000,
            __openclaw: { id: "cold-39", seq: 40, runId },
          },
          {
            role: "assistant",
            runId,
            content: "Synthetic final reply: the report is ready.",
            timestamp: 1_800_000_040_000,
            __openclaw: { id: "cold-40", seq: 41, runId, replyToId: "cold-38" },
          },
        ];
        const gateway = await installMockGateway(page, {
          sessionKey,
          authMethod: "trusted-proxy",
          authMode: "trusted-proxy",
          featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
          heldMethods: ["connect"],
          sessions: [session],
          sessionInfo: session,
          historyMessages,
          methodResponses: {
            "sessions.list": {
              ...chatSessionListResponse(
                Array.from({ length: 200 }, (_, index) => ({
                  key: `agent:main:recent-${index}`,
                  kind: "direct",
                  label: `Recent conversation ${index}`,
                  updatedAt: session.updatedAt + index + 1,
                })),
              ),
              count: 300,
            },
            "progressCard.get": { card: progressCard },
          },
        });
        await page.addInitScript(installColdLoadTitleTrace, {
          sessionKey,
          expectedTitle: session.label,
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await gateway.waitForRequest("connect");
        await gateway.resolveDeferred("connect");
        await page
          .getByText("Synthetic final reply: the report is ready.", { exact: true })
          .waitFor();
        await page.getByText("Worked for 3 minutes", { exact: true }).waitFor();
        await page.locator(".chat-reply-attribution__name").filter({ hasText: "Avery" }).waitFor();
        const progress = await openChatTaskProgress(page);
        await progress
          .locator(".task-progress-details__plan")
          .getByText("Review final report", { exact: true })
          .waitFor();
        await page.locator(".chat-pane-cache__pane--active").evaluate(async (element) => {
          const pane = element as HTMLElement & { sessionSnapshotStore?: SessionSnapshotStore };
          if (!pane.sessionSnapshotStore) {
            throw new Error("Missing transcript snapshot owner");
          }
          await pane.sessionSnapshotStore.flush();
        });
        await page.addInitScript(() => {
          const samples: ColdLoadFrame[] = [];
          const read = (): ColdLoadFrame | null => {
            const pane = document.querySelector(".chat-pane-cache__pane--active");
            const thread = pane?.querySelector<HTMLElement>(".chat-thread");
            if (
              !thread?.querySelector(".chat-virtual-row") ||
              thread.clientHeight === 0 ||
              getComputedStyle(thread.querySelector(".chat-thread-inner")!).visibility === "hidden"
            ) {
              return null;
            }
            const card = pane?.querySelector('[data-progress-card-placement="details"]');
            const threadRect = thread.getBoundingClientRect();
            return {
              title:
                pane?.querySelector(".chat-pane__session-title-text")?.textContent?.trim() ?? null,
              top: thread.scrollTop,
              max: thread.scrollHeight - thread.clientHeight,
              duration: thread.textContent.includes("Worked for 3 minutes"),
              reply: Array.from(thread.querySelectorAll(".chat-reply-attribution__name")).some(
                (element) => element.textContent?.trim() === "Avery",
              ),
              progress: card?.textContent?.includes("Review final report") === true,
              threadTop: threadRect.top,
              threadHeight: threadRect.height,
            };
          };
          Object.assign(window, {
            coldLoadSamples: samples,
            coldLoadRecording: true,
          });
          const sample = () => {
            if (!window.coldLoadRecording) {
              return;
            }
            const frame = read();
            if (frame) {
              samples.push(frame);
            }
            requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        });
        await page.addInitScript(() => window.coldLoadTitleTrace?.holdCacheRead());
        await page.reload();
        await page.waitForFunction(() => window.coldLoadTitleTrace?.cacheReadPending);
        const pendingTitles = await page.evaluate(async () => {
          const titles: string[] = [];
          for (let index = 0; index < 3; index++) {
            await new Promise<void>((resolve) => {
              requestAnimationFrame(() => resolve());
            });
            titles.push(
              document.querySelector(".chat-pane__session-title-text")?.textContent?.trim() ?? "",
            );
          }
          return titles;
        });
        expect(pendingTitles).toEqual(["", "", ""]);
        await page.evaluate(() => window.coldLoadTitleTrace?.releaseCacheRead());
        await page.waitForFunction(() => (window.coldLoadSamples?.length ?? 0) >= 20);
        const firstFrames = await page.evaluate(() => window.coldLoadSamples!.slice(0, 20));
        expectFrames(firstFrames, session.label, false);
        // Details mounts on demand; its saved progress must still be readable before hello.
        await openChatTaskProgress(page);
        await progress
          .locator(".task-progress-details__plan")
          .getByText("Review final report", { exact: true })
          .waitFor();
        // Compare the same closed-inspector scene across authentication and roster hydration.
        await closeChatDetails(page);
        const closedStart = await page.evaluate(() => window.coldLoadSamples!.length);
        await page.waitForFunction(
          (start) => (window.coldLoadSamples?.length ?? 0) >= start + 20,
          closedStart,
        );
        const samples = await page.evaluate(() => {
          if (!window.coldLoadSamples) {
            throw new Error("Missing cold-load frame recorder");
          }
          window.coldLoadCard = document.querySelector('[data-progress-card-placement="details"]');
          return window.coldLoadSamples.slice(-20);
        });
        expect(await gateway.getRequests("chat.startup")).toHaveLength(0);
        expect(samples).toHaveLength(20);
        const titleWrites = await page.evaluate(() =>
          window.coldLoadTitleTrace
            ?.read()
            .events.filter((event) => event.kind === "title-write" && event.title !== "absent"),
        );
        expect(titleWrites?.[0]?.title).toBe("expected-title");
        expect(titleWrites?.some((event) => event.title === "New session")).toBe(false);
        expectFrames(samples, session.label);
        await gateway.waitForRequest("connect");
        await page.evaluate(() => {
          window.coldLoadReconcileStart = window.coldLoadSamples?.length ?? 0;
          window.coldLoadTitleTrace?.mark("reconcile");
        });
        await gateway.resolveDeferred("connect");
        await gateway.waitForRequest("chat.startup");
        await gateway.waitForRequest("progressCard.get");
        await page.waitForFunction(() => {
          const pane = document.querySelector(".chat-pane-cache__pane--active") as
            | (HTMLElement & { transcriptReady: boolean })
            | null;
          return pane?.transcriptReady;
        });
        const reconciled = await page.evaluate(async () => {
          for (let index = 0; index < 20; index += 1) {
            await new Promise<void>((resolve) => {
              requestAnimationFrame(() => resolve());
            });
          }
          window.coldLoadRecording = false;
          return {
            frames: window.coldLoadSamples?.slice(window.coldLoadReconcileStart ?? 0) ?? [],
            retainedCard:
              window.coldLoadCard ===
              document.querySelector('[data-progress-card-placement="details"]'),
          };
        });
        expect(reconciled.retainedCard).toBe(true);
        expect(reconciled.frames.length).toBeGreaterThanOrEqual(20);
        const cached = samples[0]!;
        expectFrames(reconciled.frames, session.label);
        for (const frame of [...samples, ...reconciled.frames]) {
          for (const key of ["top", "threadTop", "threadHeight"] as const) {
            expect(Math.abs(frame[key] - cached[key])).toBeLessThanOrEqual(1);
          }
        }
      },
    );
  });
});
