import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Locator, Page } from "playwright";
import { assert, expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { showText } from "./activity-assertions.test-support.ts";
import { exactButton, polledAttribute, polledCount } from "./chat-presentation.test-support.ts";
import {
  modelPicker,
  modelSessionList,
  runtimeModel,
} from "./chat-runtime-fixtures.test-support.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";
import {
  installMockGateway as installNewSessionGateway,
  pollText,
  pollCount,
  pollAttribute,
} from "./new-session-page.test-support.ts";
import { expectRequest } from "./new-session-shard.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat model and native runtime recovery" });
const modelRef = { model: "synthetic-model", modelProvider: "fixture" };
const nativeRuntime = { id: "opencode", source: "session-key" };
const draftText = "Keep this draft; do not send automatically.";

const holdOptions = (page: Page) =>
  holdModuleResponse(
    page,
    controlUiE2eBuiltModuleRequest("ui/src/pages/chat/components/chat-model-picker-options.tsx"),
  );
async function openPicker(picker: Locator) {
  const trigger = picker.locator("[data-chat-model-select]");
  await pollAttribute(trigger, "aria-disabled").toBe("false");
  await trigger.click();
  return trigger;
}
const expectLoading = (picker: Locator) =>
  pollText(picker.locator('[role="status"]')).toContain("Loading models");

suite.define(() => {
  it.each(["durable", "volatile", "cancel"] as const)(
    "retries the first message only after saved consent: %s",
    async (mode) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        if (mode === "volatile") {
          await page.addInitScript(() => {
            // oxlint-disable-next-line typescript/unbound-method -- call(this, key, value) preserves each Storage receiver.
            const setItem = Storage.prototype.setItem;
            Storage.prototype.setItem = function (key: string, value: string) {
              if (key.startsWith("openclaw.control.chatComposer.v2:")) {
                throw new DOMException("Quota exceeded", "QuotaExceededError");
              }
              return setItem.call(this, key, value);
            };
          });
        }
        const key = "agent:main:first-native-message";
        const sessionId = "first-native-incarnation";
        const message = "Keep this first message until I retry.";
        const row = {
          key,
          sessionId,
          kind: "direct",
          ...modelRef,
          agentRuntime: nativeRuntime,
          updatedAt: 1,
        };
        const patchResponse = {
          ok: true,
          key,
          entry: { sessionId, permissionMode: "full", sandboxMode: "off" },
          resolved: modelRef,
        };
        const gateway = await installNewSessionGateway(page, {
          agentModel: "fixture/synthetic-model",
          sessionInfo: row,
          sessions: [row],
          operatorScopes: ["operator.admin"],
          deferredMethods: ["sessions.patch"],
          methodResponses: {
            "sessions.create": {
              key,
              entry: { sessionId },
              runStarted: false,
              runError: {
                code: "INVALID_REQUEST",
                message: "Native runtime restricted",
                details: {
                  code: "AGENT_RUNTIME_RESTRICTED",
                  runtimeId: "opencode",
                  runtimeLabel: "OpenCode",
                  reason: "tool-policy",
                  recovery: {
                    action: "use-native-permissions",
                    sessionId,
                    lifecycleRevision: "first-native-revision",
                    expectedPermissionMode: null,
                    expectedSandboxMode: null,
                    expectedNativeRuntimeConsent: null,
                  },
                },
              },
            },
            "sessions.patch": patchResponse,
            "chat.send": { runId: "explicit-retry", status: "started" },
          },
        });
        await page.goto(`${suite.server.baseUrl}new`);
        await page.locator(".new-session-page__message").fill(message);
        await exactButton(page, "Start session").click();
        const modal = page.locator("openclaw-modal-dialog");
        await modal.waitFor();
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
        if (mode === "cancel") {
          await exactButton(modal, "Cancel").click();
          await modal.waitFor({ state: "hidden" });
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
          expect(await page.locator(".chat-group.user").textContent()).toContain(message);
          return;
        }
        await exactButton(modal, "Continue for this chat").click();
        await expectRequest(gateway, "sessions.patch", {
          key,
          expectedSessionId: sessionId,
          nativeRuntimeConsent: "opencode",
          permissionMode: "full",
          sandboxMode: "off",
          expectedLifecycleRevision: "first-native-revision",
        });
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        await gateway.resolveDeferred("sessions.patch", patchResponse);
        await expectRequest(gateway, "chat.send", { sessionKey: key, message });
        expect(await gateway.getRequests("chat.send")).toHaveLength(1);
        expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      });
    },
  );

  it("retries the same attachment only after native permissions are saved", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const key = "agent:main:native-runtime-proof";
      const row = {
        key,
        sessionId: "synthetic-native-runtime",
        kind: "direct",
        label: "Native runtime recovery",
        ...modelRef,
        agentRuntime: nativeRuntime,
        permissionMode: "guarded",
        updatedAt: 1,
      };
      const result = modelSessionList(row, { ...modelRef, contextTokens: 128_000 });
      const gateway = await installMockGateway(page, {
        agentModel: "fixture/synthetic-model",
        sessionKey: key,
        sessionInfo: row,
        sessions: [row],
        models: [runtimeModel(row.model, "fixture", "Synthetic model", ["opencode"])],
        operatorScopes: ["operator.admin"],
        deferredMethods: ["chat.send"],
        methodResponses: { "sessions.list": result },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
      const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      const { composer, trigger, runtime } = modelPicker(pane);
      const draft = composer.locator("textarea").first();
      await draft.fill(draftText);
      await polledAttribute(trigger, "aria-disabled").toBe("false");
      await pane.locator(".agent-chat__file-input").setInputFiles({
        name: "notes.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Keep this attachment."),
      });
      await polledCount(composer.locator(".chat-attachment-thumb")).toBe(1);
      await exactButton(pane, "Send message").click();
      await gateway.waitForRequest("chat.send");
      const recovery = {
        action: "use-native-permissions",
        sessionId: row.sessionId,
        lifecycleRevision: "synthetic-revision",
        expectedPermissionMode: "guarded",
        expectedSandboxMode: null,
        expectedNativeRuntimeConsent: null,
      };
      await gateway.rejectDeferred("chat.send", {
        code: "INVALID_REQUEST",
        message: "Native harness admission refused.",
        details: {
          code: "AGENT_RUNTIME_RESTRICTED",
          runtimeId: "opencode",
          runtimeLabel: "OpenCode",
          reason: "tool-policy",
          recovery,
        },
      });
      const modal = page.locator("openclaw-modal-dialog");
      await modal.waitFor();
      for (const phrase of [
        "own permissions",
        "Gateway host",
        "Only this chat",
        "other chats and global configuration stay unchanged",
      ]) {
        expect(await modal.textContent()).toContain(phrase);
      }
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
      await gateway.deferNext("sessions.patch");
      await exactButton(modal, "Continue for this chat").click();
      const retry = await gateway.waitForRequest("sessions.patch");
      expect(retry.params).toEqual({
        key,
        expectedSessionId: row.sessionId,
        nativeRuntimeConsent: "opencode",
        permissionMode: "full",
        sandboxMode: "off",
        expectedPermissionMode: "guarded",
        expectedSandboxMode: null,
        expectedNativeRuntimeConsent: null,
        expectedLifecycleRevision: recovery.lifecycleRevision,
      });
      const selected = {
        ...row,
        permissionMode: "full",
        nativeRuntimeConsent: "opencode",
        agentRuntime: nativeRuntime,
        updatedAt: 2,
      };
      await gateway.setSessionsListResponse({ ...result, sessions: [selected] });
      await gateway.deferNext("chat.send");
      await gateway.resolveDeferred("sessions.patch", {
        ok: true,
        key,
        path: "",
        entry: {
          sessionId: row.sessionId,
          permissionMode: "full",
          sandboxMode: "off",
          nativeRuntimeConsent: "opencode",
          agentRuntimeOverride: "opencode",
          updatedAt: 2,
        },
        resolved: { ...modelRef, agentRuntime: selected.agentRuntime },
      });
      const resumed = await gateway.waitForRequest("chat.send", { after: 1 });
      expect(resumed.params).toMatchObject({
        sessionKey: key,
        message: draftText,
        attachments: [{ fileName: "notes.txt" }],
      });
      assert(isRecord(resumed.params) && typeof resumed.params.idempotencyKey === "string");
      const runId = resumed.params.idempotencyKey;
      await gateway.resolveDeferred("chat.send", { runId, status: "started" });
      await gateway.emitChatFinal({ runId, text: "Native retry completed." });
      await showText(pane.locator(".chat-group.assistant"), "Native retry completed.");
      await polledAttribute(trigger, "aria-disabled").toBe("false");
      await trigger.click();
      await polledAttribute(runtime("opencode"), "aria-selected").toBe("true");
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(1);
      expect(await gateway.getRequests("chat.send")).toHaveLength(2);
      expect(
        (await gateway.getRequests()).some((request) =>
          ["config.set", "config.patch", "config.apply"].includes(request.method),
        ),
      ).toBe(false);
      expect(await draft.inputValue()).toBe("");
    });
  });
  it.each([
    { status: "error", message: "Models unavailable" },
    { status: "offline", message: "Offline" },
  ] as const)("shows the $status catalog state when the panel arrives", ({ status, message }) =>
    suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const held = await holdOptions(page);
      const gateway = await installMockGateway(page, {
        models: [],
        methodResponses: {
          "models.list": {
            __mockError: { code: "UNAVAILABLE", message: "Synthetic catalog unavailable" },
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const picker = page.locator(".chat-controls__model-picker").first();
      const trigger = await openPicker(picker);
      await held.request;
      await gateway.waitForRequest("models.list");
      await expectLoading(picker);
      if (status === "offline") {
        await gateway.setOnline(false);
        await pollAttribute(trigger, "aria-disabled").toBe("true");
      }
      held.release();
      await picker.locator(".chat-controls__model-menu").waitFor();
      const notice = picker.locator(`[data-chat-model-catalog-state="${status}"]`);
      await expect.poll(() => notice.isVisible()).toBe(true);
      expect(await notice.textContent()).toBe(message);
      expect(await notice.getAttribute("aria-live")).toBe("polite");
    }),
  );
  it.each([
    ["new", "open"],
    ["new", "closed"],
    ["new", "focus moved"],
    ["chat", "open"],
    ["chat", "closed"],
    ["chat", "focus moved"],
  ] as const)("keeps /%s usable while model choices load (%s)", (route, state) =>
    suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const held = await holdOptions(page);
      const models = ["Alpha", "Beta"].map((name) => ({
        id: name.toLowerCase(),
        name,
        provider: "example",
        contextWindow: 128_000,
      }));
      await installMockGateway(page, {
        models,
        agentModel: "example/alpha",
        sessionInfo: { model: "alpha", modelProvider: "example" },
      });
      await page.goto(`${suite.server.baseUrl}${route}`);
      const picker = page.locator(".chat-controls__model-picker").first();
      const trigger = picker.locator("[data-chat-model-select]");
      const textarea = page.locator(".agent-chat__input textarea").first();
      await pollAttribute(trigger, "aria-disabled").toBe("false");
      expect(held.requests()).toBe(0);
      await trigger.click();
      await held.request;
      await expectLoading(picker);
      expect(await picker.getAttribute("open")).not.toBeNull();
      if (state === "closed") {
        await trigger.click();
        expect(await picker.getAttribute("open")).toBeNull();
      }
      if (state !== "open") {
        await textarea.focus();
      }
      held.release();
      const search = picker.locator("[data-chat-model-search]");
      await pollCount(search).toBe(1);
      await expect
        .poll(() =>
          page.evaluate(() => document.activeElement?.hasAttribute("data-chat-model-search")),
        )
        .toBe(state === "open");
      if (state !== "open") {
        expect(await textarea.evaluate((element) => document.activeElement === element)).toBe(true);
        expect(await picker.getAttribute("open")).toBeNull();
        await trigger.click();
      }
      await search.fill("Beta");
      const choice = picker.locator('[data-chat-model-option="example/beta"]');
      await expect.poll(() => choice.isVisible()).toBe(true);
      await search.press("Enter");
      await pollAttribute(picker, "open").toBeNull();
      expect(held.requests()).toBe(1);
    }),
  );
});
