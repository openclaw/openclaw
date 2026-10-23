import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { selectChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import { showText } from "./activity-assertions.test-support.ts";
import {
  exactButton,
  polledAttribute,
  polledCount,
  polledText,
} from "./chat-presentation.test-support.ts";
import {
  modelPicker,
  modelSessionList,
  runtimeModel,
} from "./chat-runtime-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installMockGateway as installNewSessionGateway } from "./new-session-page.test-support.ts";
import { expectRequest } from "./new-session-shard.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Native runtime recovery" });
const modelRef = { model: "synthetic-model", modelProvider: "fixture" };
const nativeRuntime = { id: "opencode", source: "session-key" };
const draftText = "Keep this draft; do not send automatically.";

suite.define(() => {
  it.each(["durable", "volatile", "cancel"] as const)(
    "retries the first message only after saved consent: %s",
    async (mode) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        if (mode === "volatile") {
          await page.addInitScript(() => {
            let quotaFailures = 0;
            Object.defineProperty(window, "composerQuotaFailures", {
              get: () => quotaFailures,
            });
            // oxlint-disable-next-line typescript/unbound-method -- call(this, key, value) preserves each Storage receiver.
            const setItem = Storage.prototype.setItem;
            Storage.prototype.setItem = function (key: string, value: string) {
              if (key.startsWith("openclaw.control.chatComposer.")) {
                quotaFailures++;
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
        const quotaFailuresBeforeStart =
          mode === "volatile"
            ? await page.evaluate(() => Reflect.get(window, "composerQuotaFailures"))
            : 0;
        await exactButton(page, "Start session").click();
        const modal = page.locator("openclaw-modal-dialog");
        await modal.waitFor();
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
        if (mode === "volatile") {
          expect(
            await page.evaluate(() => Reflect.get(window, "composerQuotaFailures")),
          ).toBeGreaterThan(quotaFailuresBeforeStart);
        }
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

  it.each(
    (["selection", "send"] as const).flatMap((entrypoint) =>
      (["confirm", "cancel", "mandatory", "non-admin"] as const).map((action) => ({
        entrypoint,
        action,
      })),
    ),
  )(
    "recovers native OpenCode only with explicit consent: $entrypoint/$action",
    async ({ entrypoint, action }) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const key = "agent:main:native-runtime-proof";
        const row = {
          key,
          sessionId: "synthetic-native-runtime",
          kind: "direct",
          label: "Native runtime recovery",
          ...modelRef,
          agentRuntime: {
            id: entrypoint === "send" ? "opencode" : "openclaw",
            source: entrypoint === "send" ? "session-key" : "model",
          },
          permissionMode: "guarded",
          updatedAt: 1,
        };
        const model = runtimeModel(row.model, "fixture", "Synthetic model", ["opencode"]);
        const result = modelSessionList(row, { ...modelRef, contextTokens: 128_000 });
        const refusalMethod = entrypoint === "send" ? "chat.send" : "sessions.patch";
        const initialPatchCount = entrypoint === "send" ? 0 : 1;
        const gateway = await installMockGateway(page, {
          agentModel: "fixture/synthetic-model",
          sessionKey: key,
          sessionInfo: row,
          sessions: [row],
          models: [model],
          operatorScopes:
            action === "non-admin" ? ["operator.read", "operator.write"] : ["operator.admin"],
          deferredMethods: [refusalMethod],
          methodResponses: { "sessions.list": result },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
        const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
        const { composer, picker, trigger, runtime } = modelPicker(pane);
        const draft = composer.locator("textarea").first();
        const attachments = composer.locator(".chat-attachment-thumb");
        const error = pane.locator(".chat-error");
        await draft.fill(draftText);
        await polledAttribute(trigger, "aria-disabled").toBe("false");
        if (entrypoint === "send") {
          await pane.locator(".agent-chat__file-input").setInputFiles({
            name: "notes.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("Keep this attachment."),
          });
          await polledCount(attachments).toBe(1);
          await exactButton(pane, "Send message").click();
          await gateway.waitForRequest("chat.send");
        } else {
          await trigger.click();
          await selectChatModelOption(picker, "fixture/synthetic-model", { runtime: "opencode" });
          await expectRequest(gateway, "sessions.patch", {
            key,
            model: "fixture/synthetic-model",
            agentRuntime: "opencode",
          });
        }
        const recovery = {
          action: "use-native-permissions",
          sessionId: row.sessionId,
          lifecycleRevision: "synthetic-revision",
          expectedPermissionMode: "guarded",
          expectedSandboxMode: null,
          expectedNativeRuntimeConsent: null,
        };
        const blocked = action === "mandatory" || action === "non-admin";
        const reason =
          action === "mandatory"
            ? "sandbox-required"
            : entrypoint === "send"
              ? "tool-policy"
              : "workspace-only";
        await gateway.rejectDeferred(refusalMethod, {
          code: "INVALID_REQUEST",
          message: "Native harness admission refused.",
          details: {
            code: "AGENT_RUNTIME_RESTRICTED",
            runtimeId: "opencode",
            runtimeLabel: "OpenCode",
            reason,
            ...(blocked ? {} : { recovery }),
          },
        });
        await page.locator("openclaw-modal-dialog, .chat-error").first().waitFor();
        if (blocked) {
          await polledText(error).toContain("Choose another model");
          expect(await exactButton(page, "Continue for this chat").count()).toBe(0);
        } else {
          const modal = page.locator("openclaw-modal-dialog");
          await modal.waitFor();
          expect(await modal.textContent()).toContain("own permissions");
          expect(await modal.textContent()).toContain("Gateway host");
          expect(await modal.textContent()).toContain("Only this chat");
          expect(await modal.textContent()).toContain(
            "other chats and global configuration stay unchanged",
          );
          expect(await gateway.getRequests("sessions.patch")).toHaveLength(initialPatchCount);
          if (action === "confirm") {
            await gateway.deferNext("sessions.patch");
          }
          await exactButton(
            modal,
            action === "confirm" ? "Continue for this chat" : "Cancel",
          ).click();
          if (action === "confirm") {
            const retry = await gateway.waitForRequest("sessions.patch", {
              after: initialPatchCount,
            });
            expect(retry.params).toEqual({
              key,
              expectedSessionId: row.sessionId,
              ...(entrypoint === "selection"
                ? { model: "fixture/synthetic-model", agentRuntime: "opencode" }
                : {}),
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
            if (entrypoint === "send") {
              await gateway.deferNext("chat.send");
            }
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
                ...(entrypoint === "selection"
                  ? { providerOverride: "fixture", modelOverride: row.model }
                  : {}),
                updatedAt: 2,
              },
              resolved: {
                ...modelRef,
                agentRuntime: selected.agentRuntime,
              },
            });
            if (entrypoint === "send") {
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
            }
            await polledAttribute(trigger, "aria-disabled").toBe("false");
            await trigger.click();
            await polledAttribute(runtime("opencode"), "aria-selected").toBe("true");
          } else {
            await polledText(error).toContain("Choose another model");
          }
        }
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(
          initialPatchCount + (action === "confirm" ? 1 : 0),
        );
        expect(await gateway.getRequests("chat.send")).toHaveLength(
          entrypoint === "send" ? (action === "confirm" ? 2 : 1) : 0,
        );
        expect(
          (await gateway.getRequests()).some((request) =>
            ["config.set", "config.patch", "config.apply"].includes(request.method),
          ),
        ).toBe(false);
        expect(await draft.inputValue()).toBe(
          entrypoint === "send" && action === "confirm" ? "" : draftText,
        );
        if (entrypoint === "send" && action !== "confirm") {
          expect(await attachments.count()).toBe(1);
          expect(await attachments.textContent()).toContain("notes.txt");
        }
      });
    },
  );
});
