import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { SessionMoveTarget } from "../../../packages/gateway-protocol/src/index.js";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { closeChatDetails, openChatDetails } from "./chat-details.test-support.ts";
import {
  chatSessionListResponse,
  createChatFlowE2eSuite,
  controlUiSessionUrl,
  installMockGateway,
  requireString,
} from "./chat-flow.test-support.ts";
import { tooltipTitleText } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

async function placementTrigger(scope: Page | Locator) {
  if (!("mainFrame" in scope)) {
    // Select the pane whose placement is being inspected before opening its Details.
    await scope.locator(".agent-chat__composer-combobox textarea").click();
  }
  const details = await openChatDetails(scope);
  const trigger = details.locator(".chat-environment__machine-trigger");
  await trigger.waitFor();
  return trigger;
}

async function openPlacement(scope: Page | Locator) {
  const trigger = await placementTrigger(scope);
  if ((await trigger.getAttribute("aria-expanded")) !== "true") {
    await trigger.click();
  }
  return trigger;
}
const sessionKey = "agent:main:placement-move";
const expectedSource = { generation: 4, environmentId: "worker:source", ownerEpoch: 7 };
const moveMethods = ["chat.startup", "environments.list", "sessions.move"];
type Gateway = Awaited<ReturnType<typeof installMockGateway>>;
async function expectMove(gateway: Gateway, target: SessionMoveTarget, abandonSource?: true) {
  expect((await gateway.waitForRequest("sessions.move")).params).toEqual({
    key: sessionKey,
    agentId: "main",
    expected: expectedSource,
    target,
    ...(abandonSource ? { abandonSource } : {}),
  });
}
const localPlacement = {
  state: "local" as const,
  generation: 9,
  createdAtMs: 1,
  updatedAtMs: 3,
  stateChangedAtMs: 3,
};
async function expectCount(locator: Locator, count = 1) {
  await expect.poll(() => locator.count()).toBe(count);
}
async function resolveMove(gateway: Gateway, placement: unknown) {
  await gateway.resolveDeferred("sessions.move", {
    ok: true,
    key: sessionKey,
    sessionId: "session-placement-move",
    placement,
  });
}
function textMessage(role: string, text: string, timestamp: number) {
  return { role, content: [{ text, type: "text" }], timestamp };
}
function runnerSession(status: "offline" | "available") {
  const session = activeSession();
  return { ...session, placement: { ...session.placement, runner: { kind: "device", status } } };
}
function installPlacementGateway(page: Page, options: Parameters<typeof installMockGateway>[1]) {
  return installMockGateway(page, { sessionKey, ...options });
}

async function assertPromptBeforeReply(transcript: Locator, prompt: string, reply: string) {
  expect(await transcript.getByText(prompt, { exact: true }).count()).toBe(1);
  expect(await transcript.getByText(reply, { exact: true }).count()).toBe(1);
  const promptBounds = await transcript.getByText(prompt, { exact: true }).boundingBox();
  const replyBounds = await transcript.getByText(reply, { exact: true }).boundingBox();
  if (!promptBounds || !replyBounds) {
    throw new Error("The placement prompt and reply must both be visible");
  }
  expect(promptBounds.y).toBeLessThan(replyBounds.y);
}

const contextOptions = {
  locale: "en-US",
  serviceWorkers: "block" as const,
  viewport: { height: 900, width: 1280 },
};

function activeSession() {
  return {
    key: sessionKey,
    sessionId: "session-placement-move",
    kind: "direct" as const,
    label: "Move proof",
    updatedAt: 2,
    hasActiveRun: true,
    placement: {
      state: "active" as const,
      generation: 4,
      createdAtMs: 1,
      updatedAtMs: 2,
      stateChangedAtMs: 2,
      environmentId: "worker:source",
      activeOwnerEpoch: 7,
      workerBundleHash: "a".repeat(64),
      workspaceBaseManifestRef: "base-manifest",
      remoteWorkspaceDir: "/workspace/move-proof",
    },
  };
}

function observedRunnerStatus(page: Page, key: string) {
  return evaluateControlUiContext(
    page,
    ({ sessions }, target) => {
      // Descriptor admission can precede every list while chat.startup is held.
      const observation = sessions.observeRow(target, () => undefined);
      try {
        const placement = observation.row?.placement;
        return placement?.state === "active" ? placement.runner?.status : undefined;
      } finally {
        observation.dispose();
      }
    },
    { key, agentId: "main" },
  );
}

suite.define(() => {
  it("shows authoritative device targets to writers and moves through the exact-source RPC", () =>
    suite.withPage(contextOptions, async ({ page }) => {
      const gateway = await installPlacementGateway(page, {
        featureMethods: moveMethods,
        operatorScopes: ["operator.read", "operator.write"],
        historyMessages: [{ role: "assistant", content: "Placement move proof." }],
        methodResponses: {
          "sessions.list": chatSessionListResponse([activeSession()]),
          "environments.list": {
            profiles: [{ id: "aws", providerId: "crabbox", trust: "disposable" }],
            environments: (
              [
                ["writer-runner", "Writer runner", { workerSlots: { total: 1, available: 1 } }],
                ["saturated", "Busy runner", { workerSlots: { total: 2, available: 0 } }],
                ["offline", "Offline runner", { status: "unavailable" }],
                ["nonhost", "Hosting disabled", { sessionHost: false }],
              ] as const
            ).map(([id, label, overrides]) =>
              Object.assign(
                { id: `node:${id}`, type: "node", label, status: "available", sessionHost: true },
                overrides,
              ),
            ),
          },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await gateway.deferNext("sessions.move");
      await openPlacement(page);
      await page.getByRole("menuitem", { name: "Move session…", exact: true }).click();
      await page.getByText("The active turn will be interrupted.", { exact: false }).waitFor();
      await page.locator('[data-value="gateway"]').waitFor();
      await page.locator('[data-value="device:writer-runner"]').waitFor();
      expect(await page.locator('[data-value="cloud:aws"]').count()).toBe(0);
      expect(await page.locator('[data-value="device:saturated"]').isDisabled()).toBe(true);
      expect(await page.locator('[data-value="device:offline"]').isDisabled()).toBe(true);
      expect(await page.locator('[data-value="device:nonhost"]').isDisabled()).toBe(true);
      await page.getByText("No worker slots are available", { exact: false }).waitFor();
      await page.getByText("Device unavailable", { exact: false }).waitFor();
      await page.getByText("Session hosting is disabled", { exact: false }).waitFor();
      expect(await gateway.getRequests("node.list")).toHaveLength(0);
      await page.locator('[data-value="device:writer-runner"]').click();

      await page.getByRole("button", { name: "Move session", exact: true }).click();
      await expectMove(gateway, { kind: "device", deviceId: "writer-runner" });
      await (
        await placementTrigger(page)
      )
        .and(page.getByRole("button", { name: /Moving session/ }))
        .waitFor();

      await resolveMove(gateway, { state: "active", generation: 10 });
    }));

  it("waits for an offline device or explicitly continues from Gateway-synced state", () =>
    suite.withPage(contextOptions, async ({ page }) => {
      const session = runnerSession("offline");
      const gateway = await installPlacementGateway(page, {
        featureMethods: ["chat.startup", "sessions.move"],
        operatorScopes: ["operator.read", "operator.write"],
        historyMessages: [{ role: "assistant", content: "Offline device recovery proof." }],
        methodResponses: {
          "sessions.list": chatSessionListResponse([session]),
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await openPlacement(page);
      await page.getByRole("button", { name: /Device offline/ }).waitFor();
      await page
        .getByText("Waiting for device to reconnect; retry after it returns", { exact: false })
        .waitFor();
      session.placement.runner.status = "available";
      await gateway.setSessionsListResponse(chatSessionListResponse([session]));
      await gateway.emitGatewayEvent("sessions.changed", { reason: "runner-availability" });
      await page.getByRole("button", { name: /Runs on device/ }).waitFor();
      expect(await page.locator(".chat-pane__placement-note").count()).toBe(0);

      session.placement.runner.status = "offline";
      await gateway.setSessionsListResponse(chatSessionListResponse([session]));
      await gateway.emitGatewayEvent("sessions.changed", { reason: "runner-availability" });
      await page.getByRole("button", { name: /Device offline/ }).waitFor();
      const continueAction = page.getByRole("menuitem", {
        name: "Continue on Gateway…",
        exact: true,
      });
      if (!(await continueAction.isVisible())) {
        await openPlacement(page);
      }
      const moveItem = page.locator(".chat-pane__placement-move");
      const reclaimItem = page.locator(".chat-pane__placement-reclaim");
      expect(await moveItem.isDisabled()).toBe(false);
      expect(await reclaimItem.isDisabled()).toBe(true);
      await expect.poll(() => tooltipTitleText(reclaimItem)).toContain("Reconnect the device");

      await gateway.deferNext("sessions.move");
      await continueAction.click();
      await page.getByText("Unsynced device files", { exact: false }).waitFor();
      await page.getByRole("button", { name: "Continue on Gateway", exact: true }).click();

      await expectMove(gateway, { kind: "gateway" }, true);
      expect(await gateway.getRequests("environments.list")).toHaveLength(0);
      expect(await gateway.getRequests("node.list")).toHaveLength(0);
      const localSession = {
        ...session,
        hasActiveRun: false,
        placement: localPlacement,
      };
      await gateway.setSessionsListResponse(chatSessionListResponse([localSession]));
      await resolveMove(gateway, localSession.placement);
      await page.locator(".chat-environment__machine-trigger").waitFor({ state: "detached" });

      expect(await page.getByRole("button", { name: "Move failed" }).count()).toBe(0);
      expect(await page.getByText("Continue on Gateway…", { exact: true }).count()).toBe(0);
    }));

  it("preserves an abandoned partial and one owned local final in both panes", () =>
    suite.withPage(contextOptions, async ({ page }) => {
      const abandonedRunId = "abandoned-placement-run";
      const partialText = "Gateway-synced device response.";
      const finalText = "Exactly one local Gateway response.";
      const session = {
        ...runnerSession("offline"),
        activeRunIds: [abandonedRunId],
        status: "running",
      };
      const originalPrompt = {
        __openclaw: {
          id: "placement-user",
          idempotencyKey: `${abandonedRunId}:user`,
          seq: 1,
        },
        ...textMessage("user", "Continue interrupted work.", 1_700_000_000_000),
      };
      const abandonedPartialIdentity = {
        id: "placement-aborted-assistant",
        seq: 2,
      };
      const abandonedPartial = {
        __openclaw: abandonedPartialIdentity,
        content: [{ text: partialText, type: "text" }],
        idempotencyKey: `${abandonedRunId}:assistant`,
        openclawAbort: { aborted: true, origin: "placement-abandon", runId: abandonedRunId },
        role: "assistant",
        stopReason: "stop",
        timestamp: 1_700_000_000_001,
      };
      const gateway = await installPlacementGateway(page, {
        featureMethods: ["chat.startup", "sessions.move"],
        historyMessages: [originalPrompt],
        inFlightRun: { runId: abandonedRunId, text: partialText },
        methodResponses: {
          "sessions.list": chatSessionListResponse([session]),
        },
        operatorScopes: ["operator.read", "operator.write"],
        sessionInfo: session,
        sessionKey,
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await (
        await placementTrigger(page)
      )
        .and(page.getByRole("button", { name: /Device offline/ }))
        .waitFor();
      await closeChatDetails(page);
      await selectChatLayoutAction(page, "Open split view");
      const panes = page.locator("openclaw-chat-pane.chat-split-view__pane");
      await expectCount(panes, 2);
      for (const pane of await panes.all()) {
        await expectCount(
          pane.locator(".chat-thread-inner").getByText(partialText, { exact: true }),
        );
      }

      await gateway.deferNext("sessions.move");
      await openPlacement(panes.last());
      await panes
        .last()
        .getByRole("menuitem", { name: "Continue on Gateway…", exact: true })
        .click();
      await page.getByRole("button", { name: "Continue on Gateway", exact: true }).click();
      await expectMove(gateway, { kind: "gateway" }, true);

      await gateway.setHistoryMessages([originalPrompt, abandonedPartial]);
      await gateway.emitGatewayEvent("session.message", {
        activeRunIds: [abandonedRunId],
        hasActiveRun: true,
        message: abandonedPartial,
        messageId: abandonedPartialIdentity.id,
        messageSeq: abandonedPartialIdentity.seq,
        runId: abandonedRunId,
        session,
        sessionKey,
      });
      await gateway.emitGatewayEvent("chat", {
        message: textMessage("assistant", partialText, 1_700_000_000_001),
        runId: abandonedRunId,
        seq: 8,
        sessionKey,
        state: "aborted",
        stopReason: "restart",
      });
      const localSession = {
        ...session,
        activeRunIds: [],
        hasActiveRun: false,
        placement: localPlacement,
        status: "done",
        updatedAt: Date.now(),
      };
      await gateway.setSessionsListResponse(chatSessionListResponse([localSession]));
      await resolveMove(gateway, localSession.placement);
      await expectCount(page.getByRole("button", { name: /Device offline/ }), 0);
      for (const pane of await panes.all()) {
        const transcript = pane.locator(".chat-thread-inner");
        await expectCount(transcript.getByText(partialText, { exact: true }));
        await expectCount(pane.locator(`[data-entry-id="${abandonedPartialIdentity.id}"]`));
      }

      const composer = panes.last().locator(".agent-chat__composer-combobox textarea");
      await composer.fill("Resume locally.");
      await panes.last().getByRole("button", { name: "Send message" }).click();
      const send = await gateway.waitForRequest("chat.send");
      const localRunId = requireString(
        (send.params as { idempotencyKey?: unknown }).idempotencyKey,
        "local placement run id",
      );
      const localUser = {
        __openclaw: {
          id: "placement-local-user",
          idempotencyKey: `${localRunId}:user`,
          seq: 3,
        },
        ...textMessage("user", "Resume locally.", 1_700_000_000_002),
      };
      const localFinalIdentity = { id: "placement-local-final", seq: 4, runId: localRunId };
      const localFinal = {
        __openclaw: localFinalIdentity,
        ...textMessage("assistant", finalText, 1_700_000_000_003),
      };
      await gateway.emitGatewayEvent("chat", {
        deltaText: finalText,
        message: textMessage("assistant", finalText, 1_700_000_000_003),
        runId: localRunId,
        seq: 5,
        sessionKey,
        state: "delta",
      });
      for (const pane of await panes.all()) {
        await pane.locator(".chat-bubble.streaming", { hasText: finalText }).waitFor();
      }
      await gateway.setHistoryMessages([originalPrompt, abandonedPartial, localUser, localFinal]);
      await gateway.emitGatewayEvent("chat", {
        deltaText: "",
        message: { role: "assistant", content: [] },
        replace: true,
        runId: localRunId,
        sessionKey,
        state: "delta",
      });
      await gateway.emitGatewayEvent("session.message", {
        activeRunIds: null,
        hasActiveRun: true,
        message: localFinal,
        messageId: localFinalIdentity.id,
        messageSeq: localFinalIdentity.seq,
        runId: localRunId,
        session: {
          ...localSession,
          activeRunIds: null,
          hasActiveRun: true,
          status: "running",
        },
        sessionKey,
      });
      for (const pane of await panes.all()) {
        await expectCount(pane.locator(`[data-entry-id="${localFinalIdentity.id}"]`));
      }

      const sendingTranscript = panes.last().locator(".chat-thread-inner");
      await assertPromptBeforeReply(sendingTranscript, "Resume locally.", finalText);

      const assertSettledPane = async (pane: Locator) => {
        const transcript = pane.locator(".chat-thread-inner");
        await expectCount(transcript.getByText(partialText, { exact: true }));
        await expectCount(transcript.getByText(finalText, { exact: true }));
        await assertPromptBeforeReply(transcript, "Resume locally.", finalText);
        expect(await pane.locator(`[data-entry-id="${localFinalIdentity.id}"]`).count()).toBe(1);
      };
      await gateway.emitGatewayEvent("chat", {
        runId: localRunId,
        sessionKey,
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: finalText }],
          openclawDisplayContent: [],
        },
      });
      for (const pane of await panes.all()) {
        await assertSettledPane(pane);
      }

      await gateway.setMethodResponse("chat.history", {
        inFlightRun: null,
        messages: [originalPrompt, abandonedPartial, localUser, localFinal],
        sessionId: "session-placement-move",
        sessionInfo: localSession,
        thinkingLevel: null,
      });
      await page.reload();
      const reloadedPanes = page.locator("openclaw-chat-pane.chat-split-view__pane");
      await expectCount(reloadedPanes, 2);
      for (const pane of await reloadedPanes.all()) {
        await assertSettledPane(pane);
      }
    }));

  it("keeps a rapid offline publication over stale deferred startup hydration", () =>
    suite.withPage(contextOptions, async ({ page }) => {
      const parent = {
        key: "agent:main:placement-parent",
        sessionId: "session:agent:main:placement-parent",
        kind: "direct" as const,
        label: "Placement parent",
        updatedAt: 1,
        childSessions: ["agent:main:placement-move"],
      };
      const available = { ...runnerSession("available"), parentSessionKey: parent.key };
      const offline = { ...runnerSession("offline"), parentSessionKey: parent.key };
      const historyMessages = [
        { role: "assistant", content: "Deferred available startup transcript settled." },
      ];
      const models = [{ id: "gpt-5.5", name: "gpt-5.5", provider: "openai" }];
      const staleStartup = {
        sessionId: available.sessionId,
        sessionInfo: { ...available, archived: false, pinned: false },
        messages: historyMessages,
        thinkingLevel: null,
        metadata: { models },
      };
      const gateway = await installPlacementGateway(page, {
        subscriptionInitialHistory: false,
        deferredMethods: ["chat.startup"],
        featureMethods: ["chat.startup", "sessions.move"],
        historyMessages,
        models,
        methodResponses: {
          "sessions.list": {
            cases: [
              { match: { spawnedBy: parent.key }, response: chatSessionListResponse([available]) },
              { response: chatSessionListResponse([parent, available]) },
            ],
          },
        },
        sessionInfo: available,
        sessions: [parent, available],
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await gateway.waitForRequest("chat.startup");
      await (
        await placementTrigger(page)
      )
        .and(page.getByRole("button", { name: /Runs on device/ }))
        .waitFor();
      await expect.poll(() => observedRunnerStatus(page, available.key)).toBe("available");
      const presentation = await page.evaluateHandle(() => {
        const state = { returnedOnline: false, seenOffline: false };
        const inspect = () => {
          const labels = new Set(
            [...document.querySelectorAll(".chat-environment__machine-trigger")].map(
              (button) => button.getAttribute("aria-label") ?? "",
            ),
          );
          if ([...labels].some((label) => label.includes("Device offline"))) {
            state.seenOffline = true;
          }
          if (state.seenOffline && [...labels].some((label) => label.includes("Runs on device"))) {
            state.returnedOnline = true;
          }
        };
        new MutationObserver(inspect).observe(document.body, {
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: ["aria-label"],
          subtree: true,
        });
        inspect();
        return state;
      });
      const descriptorMatch = { key: available.key };
      const descriptorCount = (await gateway.getRequests("sessions.describe", descriptorMatch))
        .length;
      // Current primary, child, and descriptor reads share one offline fixture owner.
      await gateway.setSessionsListResponse(chatSessionListResponse([parent, offline]));
      await gateway.setMethodResponse("sessions.list", {
        cases: [
          { match: { spawnedBy: parent.key }, response: chatSessionListResponse([offline]) },
          { response: chatSessionListResponse([parent, offline]) },
        ],
      });
      await gateway.deferNext("sessions.describe", descriptorMatch);
      // Delay presentation frames while both Gateway receipts reach their data owners.
      const releaseFrames = await page.evaluateHandle(() => {
        const request = window.requestAnimationFrame;
        const cancel = window.cancelAnimationFrame;
        const queued = new Map<number, FrameRequestCallback>();
        let held = true;
        window.requestAnimationFrame = (callback) => {
          const id = request.call(window, (time) => {
            if (held) {
              queued.set(id, callback);
            } else {
              callback(time);
            }
          });
          return id;
        };
        window.cancelAnimationFrame = (id) => {
          queued.delete(id);
          cancel.call(window, id);
        };
        return () => {
          held = false;
          window.requestAnimationFrame = request;
          window.cancelAnimationFrame = cancel;
          for (const callback of queued.values()) {
            request.call(window, callback);
          }
          queued.clear();
        };
      });
      await gateway.emitGatewayEvent("sessions.changed", { reason: "runner-availability" });
      await gateway.waitForRequest("sessions.describe", {
        after: descriptorCount,
        match: descriptorMatch,
      });
      await gateway.emitGatewayEvent("sessions.changed", { reason: "runner-availability" });
      expect(await gateway.getRequests("sessions.describe", descriptorMatch)).toHaveLength(
        descriptorCount + 1,
      );
      await releaseFrames.evaluate((release) => release());
      await gateway.resolveDeferred("sessions.describe", { session: available });
      await gateway.waitForRequest("sessions.describe", {
        after: descriptorCount + 1,
        match: descriptorMatch,
      });
      await page.getByRole("button", { name: /Device offline/ }).waitFor();
      expect(await observedRunnerStatus(page, available.key)).toBe("offline");
      expect(await gateway.getRequests("sessions.describe", descriptorMatch)).toHaveLength(
        descriptorCount + 2,
      );
      expect(await gateway.getSocketCount()).toBe(1);

      await selectChatLayoutAction(page, "Open split view");
      const panes = page.locator("openclaw-chat-pane.chat-split-view__pane");
      await expectCount(panes, 2);
      expect(await gateway.getRequests("chat.startup")).toHaveLength(1);

      await gateway.resolveDeferred("chat.startup", staleStartup);
      await expectCount(page.getByText("Deferred available startup transcript settled."), 2);
      for (const pane of await panes.all()) {
        await (
          await placementTrigger(pane)
        )
          .and(pane.getByRole("button", { name: /Device offline/ }))
          .waitFor();
      }
      expect(await page.getByRole("button", { name: /Runs on device/ }).count()).toBe(0);
      expect(await presentation.jsonValue()).toEqual({ returnedOnline: false, seenOffline: true });
      await openPlacement(panes.last());
      await panes
        .last()
        .getByText("Waiting for device to reconnect; retry after it returns", { exact: false })
        .waitFor();
    }));

  it.each(["fast", undefined] as const)("moves to a cloud profile with machine %s", (machineId) =>
    suite.withPage(contextOptions, async ({ page }) => {
      const gateway = await installPlacementGateway(page, {
        featureMethods: moveMethods,
        operatorScopes: ["operator.admin", "operator.read", "operator.write"],
        historyMessages: [{ role: "assistant", content: "Placement machine proof." }],
        methodResponses: {
          "sessions.list": chatSessionListResponse([activeSession()]),
          "environments.list": {
            profiles: [
              {
                id: "aws",
                providerId: "crabbox",
                trust: "disposable",
                ...(machineId
                  ? {
                      machines: [
                        { id: "standard", label: "Standard", default: true },
                        { id: "fast", label: "Fast" },
                      ],
                    }
                  : {}),
              },
            ],
            environments: [],
          },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await gateway.deferNext("sessions.move");
      await openPlacement(page);
      await page.getByRole("menuitem", { name: "Move session…", exact: true }).click();
      const profile = page.locator('[data-value="cloud:aws"]');
      await profile.click();
      await expect.poll(() => profile.getAttribute("aria-pressed")).toBe("true");
      if (machineId) {
        await page.getByRole("button", { name: "Machine", exact: true }).click();
        await page
          .getByRole("menu", { name: "Machine", exact: true })
          .locator(`[role="menuitemradio"][data-value="${machineId}"]`)
          .click();
      } else {
        const dialog = page.locator("openclaw-modal-dialog");
        expect(await dialog.getByText("Machine", { exact: true }).count()).toBe(0);
        expect(await dialog.getByRole("button", { name: "Machine", exact: true }).count()).toBe(0);
      }
      await page.getByRole("button", { name: "Move session", exact: true }).click();

      await expectMove(gateway, {
        kind: "profile",
        profileId: "aws",
        ...(machineId ? { machineClass: machineId } : {}),
      });
      await resolveMove(gateway, { state: "active", generation: 10 });
    }),
  );
});
