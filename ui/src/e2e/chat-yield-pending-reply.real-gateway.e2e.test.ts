import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  BUILD_STAMP_FILE,
  RUNTIME_POSTBUILD_STAMP_FILE,
} from "../../../scripts/lib/local-build-metadata-paths.mts";
import type { OpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import type { SessionsListResult } from "../api/types.ts";
import type { ChatHistoryResult } from "../pages/chat/chat-history-snapshot.ts";
import { pairControlUiPage } from "../test-helpers/control-ui-browser-pairing.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import { observeBackgroundWorkRpc } from "./background-work.real-gateway.test-support.ts";
import { connectChatGateway, runGatewayCli } from "./chat-real-gateway.test-support.ts";
import {
  createWaitClockInstance,
  startWaitClockProvider,
  waitClockFixture as fixture,
} from "./chat-wait-clock.real-gateway.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

// Product E2E: a parent update turn delivers its reply with the message tool, then its
// sessions_yield finds the earlier turn's child still pending. Only model responses are scripted.
const uiRoot = path.resolve(process.env.OPENCLAW_UI_E2E_WAIT_CLOCK_UI_ROOT || "dist/control-ui");
let instance: OpenClawTestInstance;
let client: Awaited<ReturnType<typeof connectChatGateway>>;
let provider: Awaited<ReturnType<typeof startWaitClockProvider>>;
let artifactDir: string;
const proof: Record<string, unknown> = {
  gateway: "real isolated Gateway and Chromium; native visible child registry",
  provider: "scripted loopback OpenAI Responses transport; NOT external-provider live proof",
  complete: false,
};
const saveProof = () =>
  fs.writeFile(path.join(artifactDir, "proof.json"), JSON.stringify(proof, null, 2) + "\n");
const suite = createControlUiE2eSuite({
  name: "Already-pending yield after a delivered reply through a real Gateway",
  startServerBeforeBrowser: true,
  resources: {
    async run(signal) {
      client = await connectChatGateway(instance, signal);
    },
    async close() {
      await client?.stopAndWait();
    },
  },
  async startServer() {
    artifactDir = createControlUiE2eArtifactDir("yield-pending-reply-" + path.basename(uiRoot));
    await Promise.all(
      [
        "dist/index.js",
        "dist/" + BUILD_STAMP_FILE,
        "dist/" + RUNTIME_POSTBUILD_STAMP_FILE,
        path.join(uiRoot, "index.html"),
      ].map((file) => fs.access(file)),
    );
    provider = await startWaitClockProvider({ updateVia: "message-tool" });
    const cleanup = () =>
      runQaGatewayFixture(
        async () => {
          await instance?.cleanup();
          proof.gatewayStopped = !instance?.child;
        },
        async () => {
          await provider.stop();
          proof.providerStopped = true;
        },
        saveProof,
      );
    try {
      instance = await createWaitClockInstance(provider.port, uiRoot, {
        visibleReplies: "message_tool",
      });
      await instance.startGateway();
      return { baseUrl: "http://127.0.0.1:" + instance.port + "/", close: cleanup };
    } catch (error) {
      return runQaGatewayFixture(async () => {
        throw error;
      }, cleanup);
    }
  },
});

const call = <T = Record<string, unknown>>(method: string, params: Record<string, unknown>) =>
  client.request<T>(method, params);
async function parentEndedAt() {
  const result = await call<SessionsListResult>("sessions.list", { agentId: "main", limit: 50 });
  return result.sessions.find((row) => row.key === fixture.key)?.endedAt ?? 0;
}

suite.define(() => {
  it("ends the update turn at an already-pending yield once its reply was delivered", async (test) => {
    await suite.runScenario(test, {
      retainedState: () => instance.stateDir,
      run: async (signal) => {
        const context = await suite.newBrowserContext({
          ...createControlUiE2eContextOptions(),
          viewport: { width: 1440, height: 1000 },
          colorScheme: "dark",
        });
        await context.addInitScript(() => {
          localStorage.setItem(
            "openclaw:control-ui:community-invite:v2",
            JSON.stringify({ dismissedAtMs: 1770000000000 }),
          );
        });
        const page = await context.newPage();
        await page.clock.install();
        const wire = observeBackgroundWorkRpc(page, signal);
        try {
          proof.stage = "create parent and pair browser";
          await call("sessions.create", {
            key: fixture.key,
            agentId: "main",
            label: fixture.label,
          });
          await pairControlUiPage(page, (args) => runGatewayCli(instance, args));
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, fixture.key));
          await waitForControlUiGatewayReady(page);
          const parent = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
          const composer = parent.getByRole("textbox", { name: "Chat composer", exact: true });
          await composer.waitFor();
          const send = async (message: string) => {
            const before = wire.completed.length;
            await composer.fill(message);
            await parent.locator(".chat-send-btn--send").click();
            const rpc = await wire.waitFor((entry) => entry.request.method === "chat.send", before);
            expect(rpc.response.ok, JSON.stringify(rpc.response.error)).toBe(true);
          };
          const narration = parent
            .getByRole("paragraph")
            .filter({ hasText: fixture.trailingNarration });

          proof.stage = "actual visible child launch and initial parent yield";
          await send(fixture.initialPrompt);
          await provider.waitForChild(signal);
          await expect.poll(parentEndedAt).toBeGreaterThan(0);
          const initialEndedAt = await parentEndedAt();

          proof.stage = "update delivered by the message tool, then an already-pending yield";
          await send(fixture.updatePrompt);
          await expect.poll(parentEndedAt).toBeGreaterThan(initialEndedAt);
          const updateReply = parent
            .getByRole("paragraph")
            .filter({ hasText: fixture.updateReply });
          await expect.poll(() => updateReply.count()).toBe(1);
          await provider.check();
          // The yield's real already_pending result ends the turn, so the model never receives it.
          expect(provider.receipts.map((receipt) => receipt.tool)).toEqual([
            "sessions_spawn",
            "message",
          ]);
          const history = await call<ChatHistoryResult>("chat.history", {
            sessionKey: fixture.key,
            limit: 50,
          });
          proof.updateTurn = {
            parentRequests: provider.parentRequests(),
            trailingNarrationRequests: provider.trailingNarrationRequests(),
            visibleNarration: await narration.count(),
            historyHasNarration: JSON.stringify(history.messages).includes(
              fixture.trailingNarration,
            ),
          };
          // The reply is already out and the earlier wake resumes the parent: no further model
          // request for this turn, and no trailing narration in the transcript or the chat.
          expect(proof.updateTurn).toEqual({
            parentRequests: 4,
            trailingNarrationRequests: 0,
            visibleNarration: 0,
            historyHasNarration: false,
          });
          await pauseVirtualClock(page);
          try {
            const frame = await takeControlUiScreenshotFrame(page, parent, [updateReply], {
              animations: "disabled",
            });
            await fs.writeFile(path.join(artifactDir, "after-update.png"), frame.png);
          } finally {
            await page.clock.resume();
          }

          proof.stage = "actual child completion and parent resume";
          const updatedEndedAt = await parentEndedAt();
          provider.releaseChild();
          await expect.poll(parentEndedAt).toBeGreaterThan(updatedEndedAt);
          // Message-tool-only replies keep the resumed text in the transcript, not as a delivery.
          await expect
            .poll(async () =>
              JSON.stringify(
                (
                  await call<ChatHistoryResult>("chat.history", {
                    sessionKey: fixture.key,
                    limit: 50,
                  })
                ).messages,
              ),
            )
            .toContain(fixture.resumedReply);
          await provider.check();
          expect(provider.parentRequests()).toBe(5);
          expect(provider.trailingNarrationRequests()).toBe(0);
          expect(await narration.count()).toBe(0);
          proof.complete = true;
          proof.stage = "complete";
        } finally {
          proof.toolReceipts = provider.receipts;
          proof.providerRequests = provider.requests;
          let logs = instance.logs();
          for (const secret of [
            instance.gatewayToken,
            instance.hookToken,
            instance.homeDir,
            instance.stateDir,
            "synthetic-wait-fixture-key",
          ]) {
            logs = logs.replaceAll(secret, "[fixture-private]");
          }
          await fs.writeFile(path.join(artifactDir, "gateway.private.log"), logs);
          await saveProof();
        }
      },
    });
  }, 120_000);
});
