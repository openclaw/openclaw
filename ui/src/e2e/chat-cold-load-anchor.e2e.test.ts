import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { SessionSnapshotStore } from "../pages/chat/session-snapshot-store.ts";
import {
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

type ColdLoadFrame = {
  top: number;
  max: number;
  duration: boolean;
  reply: boolean;
  progress: boolean;
  threadTop: number;
  threadHeight: number;
  cardTop: number | null;
  cardHeight: number | null;
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

suite.define(() => {
  it("paints the cached tail, reply metadata, and progress before hello and reconciles in place", async () => {
    await suite.withPage(
      {
        viewport: { width: 1200, height: 900 },
        serviceWorkers: "block",
        recordVideo: { dir: suite.artifactDir, size: { width: 1200, height: 900 } },
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
          methodResponses: { "progressCard.get": { card: progressCard } },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await gateway.waitForRequest("connect");
        await gateway.resolveDeferred("connect");
        await page
          .getByText("Synthetic final reply: the report is ready.", { exact: true })
          .waitFor();
        await page.getByText("Worked for 3 minutes", { exact: true }).waitFor();
        await page.locator(".chat-reply-attribution__name").filter({ hasText: "Avery" }).waitFor();
        await page
          .locator('[data-progress-card-placement="composer"]')
          .filter({ hasText: "Review final report" })
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
            if (!thread?.querySelector(".chat-virtual-row") || thread.clientHeight === 0) {
              return null;
            }
            const card = pane?.querySelector('[data-progress-card-placement="composer"]');
            const cardRect = card?.getBoundingClientRect();
            const threadRect = thread.getBoundingClientRect();
            return {
              top: thread.scrollTop,
              max: thread.scrollHeight - thread.clientHeight,
              duration: thread.textContent.includes("Worked for 3 minutes"),
              reply: Array.from(thread.querySelectorAll(".chat-reply-attribution__name")).some(
                (element) => element.textContent?.trim() === "Avery",
              ),
              progress: card?.textContent?.includes("Review final report") === true,
              threadTop: threadRect.top,
              threadHeight: threadRect.height,
              cardTop: cardRect?.top ?? null,
              cardHeight: cardRect?.height ?? null,
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
        await page.reload();
        await page.waitForFunction(() => (window.coldLoadSamples?.length ?? 0) >= 20);
        const samples = await page.evaluate(() => {
          if (!window.coldLoadSamples) {
            throw new Error("Missing cold-load frame recorder");
          }
          window.coldLoadCard = document.querySelector('[data-progress-card-placement="composer"]');
          return window.coldLoadSamples.slice(0, 20);
        });
        await writeFile(
          path.join(suite.artifactDir, "cold-load-cached-frames.json"),
          JSON.stringify(samples),
        );
        await page.screenshot({ path: path.join(suite.artifactDir, "cold-load-cached.png") });
        expect(await gateway.getRequests("chat.startup")).toHaveLength(0);
        expect(samples).toHaveLength(20);
        for (const frame of samples) {
          expect(Math.abs(frame.max - frame.top)).toBeLessThanOrEqual(1);
          expect(frame).toMatchObject({ duration: true, reply: true, progress: true });
        }
        await gateway.waitForRequest("connect");
        await page.evaluate(() => {
          window.coldLoadReconcileStart = window.coldLoadSamples?.length ?? 0;
        });
        await gateway.resolveDeferred("connect");
        await gateway.waitForRequest("chat.startup");
        await gateway.waitForRequest("progressCard.get");
        await page.waitForFunction(() => {
          const pane = document.querySelector(".chat-pane-cache__pane--active") as
            | (HTMLElement & { state?: { connected: boolean; chatLoading: boolean } })
            | null;
          return pane?.state?.connected && !pane.state.chatLoading;
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
              document.querySelector('[data-progress-card-placement="composer"]'),
          };
        });
        await writeFile(
          path.join(suite.artifactDir, "cold-load-frames.json"),
          JSON.stringify({ cached: samples, live: reconciled.frames }),
        );
        await page.screenshot({ path: path.join(suite.artifactDir, "cold-load-live.png") });
        expect(reconciled.retainedCard).toBe(true);
        expect(reconciled.frames.length).toBeGreaterThanOrEqual(20);
        const cached = samples[0]!;
        for (const frame of [...samples, ...reconciled.frames]) {
          expect(frame).toMatchObject({ duration: true, reply: true, progress: true });
          expect(Math.abs(frame.max - frame.top)).toBeLessThanOrEqual(1);
          for (const key of [
            "top",
            "threadTop",
            "threadHeight",
            "cardTop",
            "cardHeight",
          ] as const) {
            expect(frame[key]).not.toBeNull();
            expect(Math.abs(frame[key]! - cached[key]!)).toBeLessThanOrEqual(1);
          }
        }
      },
    );
  });
});
