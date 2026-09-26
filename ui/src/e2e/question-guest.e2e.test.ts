import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { withOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import type { MockGatewayWindow } from "../test-helpers/control-ui-e2e-contract.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  createGuestQuestionFixture,
  guestQuestionPrompt,
  guestQuestionScopes,
  guestQuestionSessionKey,
} from "./question-guest.test-support.ts";

declare global {
  interface Window {
    dispatchGuestQuestion: Awaited<ReturnType<typeof createGuestQuestionFixture>>["request"];
  }
}

const suite = createControlUiE2eSuite({
  name: "Guest ordinary question lifecycle",
  startServerBeforeBrowser: true,
});
const viewport = { width: 1440, height: 900 };
const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

async function releaseQuestionBridge(page: Page, gateway: MockGatewayControls) {
  await gateway.waitForRequest("connect");
  await page.evaluate(() => {
    const owner: MockGatewayWindow = window;
    if (!owner.openclawControlUiE2eGateway) {
      throw new Error("question browser fixture is not installed");
    }
    for (const method of ["question.list", "question.get", "question.resolve"]) {
      owner.openclawControlUiE2eGateway.setRequestHandler(method, ({ params, respond }) => {
        void owner.dispatchGuestQuestion(method, params).then((result) => {
          respond(result.ok ? result.payload : { __mockError: result.error });
        });
      });
    }
  });
  await gateway.resolveDeferred("connect");
}

suite.define(() => {
  it("recovers and answers its own admitted run's question and settles cancellation", async () => {
    const artifactDir = capture
      ? createControlUiE2eArtifactDir(
          "question-guest",
          path.resolve(".artifacts/ui-visual-proof/guest-questions"),
        )
      : undefined;
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const context = await suite.newBrowserContext({
        locale: "en-US",
        colorScheme: "dark",
        serviceWorkers: "block",
        viewport,
        ...(artifactDir ? { recordVideo: { dir: artifactDir, size: viewport } } : {}),
      });
      const page = await context.newPage();
      let gateway: MockGatewayControls | undefined;
      const fixture = await createGuestQuestionFixture(async (frame) => {
        if (!gateway) {
          throw new Error("question event arrived before its browser recipient");
        }
        await gateway.deliverLatest(frame);
      });
      const turns: Promise<unknown>[] = [];
      const run = new AbortController();
      const screenshot = async (name: string) => {
        if (artifactDir) {
          const surface = page.locator(".chat-main__conversation");
          await fs.writeFile(
            path.join(artifactDir, name),
            await takeControlUiViewportScreenshot(page, surface, [
              page.getByText("Summary draft", { exact: true }).first(),
            ]),
          );
        }
      };
      try {
        await page.exposeFunction("dispatchGuestQuestion", fixture.request);
        gateway = await installMockGateway(page, {
          heldMethods: ["connect"],
          operatorScopes: guestQuestionScopes,
          sessionKey: guestQuestionSessionKey,
          mainSessionKey: "agent:main:main",
          communityInvite: false,
          featureMethods: [
            "chat.startup",
            "chat.metadata",
            "question.list",
            "question.get",
            "question.resolve",
          ],
          presenceUsers: [
            {
              self: true,
              id: fixture.profileId,
              identity: { type: "profile", id: fixture.profileId },
              name: "Guest",
            },
          ],
          sessions: [
            {
              key: guestQuestionSessionKey,
              sessionId: "guest-question-session",
              label: "Summary draft",
              kind: "direct",
              visibility: "shared",
              sharingRole: "owner",
              updatedAt: Date.now(),
            },
          ],
          historyMessages: [
            {
              role: "user",
              content: [{ type: "text", text: "Help me prepare a project summary." }],
            },
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "I have the outline ready. I need your preference before continuing.",
                },
              ],
            },
          ],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, guestQuestionSessionKey));
        await releaseQuestionBridge(page, gateway);
        await gateway.waitForRequest("chat.startup");
        await page
          .getByText("I have the outline ready. I need your preference before continuing.", {
            exact: true,
          })
          .waitFor();
        const result = fixture.ask("summary-format", run.signal).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        turns.push(result);
        const registered = await fixture.registration;
        await fixture.flushEvents();
        const panel = page.locator(".agent-chat__question-dock openclaw-chat-question-panel");
        if (!registered.ok) {
          expect(await panel.count()).toBe(0);
          await screenshot("ordinary-question-unavailable.png");
          if (artifactDir) {
            await fs.writeFile(
              path.join(artifactDir, "baseline.json"),
              JSON.stringify(
                {
                  scopes: guestQuestionScopes,
                  sessionKey: guestQuestionSessionKey,
                  registration: registered,
                  questionPanels: 0,
                },
                null,
                2,
              ),
            );
          }
        }
        expect(
          registered,
          "The Guest's original agent run must register an ordinary question",
        ).toMatchObject({ ok: true });
        await panel.getByText(guestQuestionPrompt, { exact: true }).waitFor();
        await screenshot("ordinary-question-pending.png");
        const initialLists = fixture.requests.filter(
          (request) => request.method === "question.list",
        ).length;

        fixture.disconnect();
        await page.reload();
        fixture.reconnect();
        await releaseQuestionBridge(page, gateway);
        await panel.getByText(guestQuestionPrompt, { exact: true }).waitFor();
        expect(
          fixture.requests.filter((request) => request.method === "question.list").length,
        ).toBeGreaterThan(initialLists);
        await panel.getByRole("radio", { name: /Concise/ }).click();
        await panel.getByRole("button", { name: "Submit", exact: true }).click();
        expect(await result).toMatchObject({
          ok: true,
          value: { details: { status: "answered", answers: { answers: { format: ["Concise"] } } } },
        });
        await page.locator(".chat-question-summary").filter({ hasText: "Concise" }).waitFor();
        expect(await panel.count()).toBe(0);
        await screenshot("ordinary-question-answered.png");

        const cancelled = fixture.ask("cancelled-format", run.signal).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        turns.push(cancelled);
        await panel.getByText(guestQuestionPrompt, { exact: true }).waitFor();
        run.abort(new Error("Synthetic run stopped"));
        expect(await cancelled).toMatchObject({ ok: false });
        await fixture.flushEvents();
        await page.locator(".chat-question-summary").filter({ hasText: "Skipped" }).waitFor();
        expect(await panel.count()).toBe(0);
        expect(
          fixture.requests.some(
            (request) =>
              request.method === "question.resolve" &&
              request.result?.ok &&
              typeof request.params === "object" &&
              request.params !== null &&
              "cancel" in request.params,
          ),
        ).toBe(true);
        await screenshot("ordinary-question-cancelled.png");
      } finally {
        run.abort();
        await fixture.close();
        await Promise.allSettled(turns);
        await suite.closeBrowserContext(context);
      }
    });
  });
});
