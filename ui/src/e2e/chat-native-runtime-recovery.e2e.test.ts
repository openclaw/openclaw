import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, describe, expect, it } from "vitest";
import type { ModelCatalogEntry } from "../api/types.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { selectChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installMockGateway as installNewSessionGateway } from "./new-session-page.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Native runtime recovery" });

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
          model: "synthetic-model",
          modelProvider: "fixture",
          agentRuntime: { id: "opencode", source: "session-key" },
          updatedAt: 1,
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
            "sessions.patch": {
              ok: true,
              key,
              entry: { sessionId, permissionMode: "full", sandboxMode: "off" },
              resolved: { model: row.model, modelProvider: row.modelProvider },
            },
            "chat.send": { runId: "explicit-retry", status: "started" },
          },
        });
        await page.goto(`${suite.server.baseUrl}new`);
        await page.locator(".new-session-page__message").fill(message);
        await page.getByRole("button", { name: "Start session", exact: true }).click();
        const modal = page.locator("openclaw-modal-dialog");
        await modal.waitFor();
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
        if (mode === "cancel") {
          await modal.getByRole("button", { name: "Cancel", exact: true }).click();
          await modal.waitFor({ state: "hidden" });
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
          expect(await page.locator(".chat-group.user").textContent()).toContain(message);
          return;
        }
        await modal.getByRole("button", { name: "Continue for this chat", exact: true }).click();
        const patch = await gateway.waitForRequest("sessions.patch");
        expect(patch.params).toMatchObject({
          key,
          expectedSessionId: sessionId,
          nativeRuntimeConsent: "opencode",
          permissionMode: "full",
          sandboxMode: "off",
          expectedLifecycleRevision: "first-native-revision",
        });
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        await gateway.resolveDeferred("sessions.patch", {
          ok: true,
          key,
          entry: { sessionId, permissionMode: "full", sandboxMode: "off" },
          resolved: { model: row.model, modelProvider: row.modelProvider },
        });
        const retry = await gateway.waitForRequest("chat.send");
        expect(retry.params).toMatchObject({ sessionKey: key, message });
        expect(await gateway.getRequests("chat.send")).toHaveLength(1);
        expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      });
    },
  );

  describe.each(["selection", "send"] as const)("%s refusal", (entrypoint) => {
    it.each(["confirm", "cancel", "mandatory", "non-admin"] as const)(
      "recovers native OpenCode only with explicit consent: %s",
      async (action) => {
        await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
          const artifactDir = createControlUiE2eArtifactDir(
            "native-runtime-" + entrypoint + "-" + action,
          );
          const key = "agent:main:native-runtime-proof";
          const row = {
            key,
            sessionId: "synthetic-native-runtime",
            kind: "direct",
            label: "Native runtime recovery",
            model: "synthetic-model",
            modelProvider: "fixture",
            agentRuntime: {
              id: entrypoint === "send" ? "opencode" : "openclaw",
              source: entrypoint === "send" ? "session-key" : "model",
            },
            permissionMode: "guarded",
            updatedAt: 1,
          };
          const model = {
            id: row.model,
            name: "Synthetic model",
            provider: "fixture",
            available: true,
            agentRuntime: { id: "openclaw", source: "model" },
            runtimeChoices: [
              { agentRuntime: { id: "opencode", source: "model" }, available: true },
            ],
          } satisfies ModelCatalogEntry;
          const result = {
            ts: 1,
            path: "",
            count: 1,
            defaults: {
              model: row.model,
              modelProvider: row.modelProvider,
              contextTokens: 128_000,
            },
            sessions: [row],
          };
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
          const composer = pane.locator(".agent-chat__input").first();
          const draft = composer.locator("textarea").first();
          await draft.fill("Keep this draft; do not send automatically.");
          const picker = composer.locator(".chat-controls__model-picker");
          const trigger = picker.locator("[data-chat-model-select]");
          await expect.poll(() => trigger.getAttribute("aria-disabled")).toBe("false");
          if (entrypoint === "send") {
            await pane.locator(".agent-chat__file-input").setInputFiles({
              name: "notes.txt",
              mimeType: "text/plain",
              buffer: Buffer.from("Keep this attachment."),
            });
            await expect.poll(() => composer.locator(".chat-attachment-thumb").count()).toBe(1);
            await pane.getByRole("button", { name: "Send message", exact: true }).click();
            await gateway.waitForRequest("chat.send");
          } else {
            await trigger.click();
            await selectChatModelOption(picker.locator('[data-chat-model-runtime="opencode"]'));
            const initialPatch = await gateway.waitForRequest("sessions.patch");
            expect(initialPatch.params).toMatchObject({
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
          await gateway.rejectDeferred(refusalMethod, {
            code: "INVALID_REQUEST",
            message: "Native harness admission refused.",
            details: {
              code: "AGENT_RUNTIME_RESTRICTED",
              runtimeId: "opencode",
              runtimeLabel: "OpenCode",
              reason:
                action === "mandatory"
                  ? "sandbox-required"
                  : entrypoint === "send"
                    ? "tool-policy"
                    : "workspace-only",
              ...(action === "mandatory" || action === "non-admin" ? {} : { recovery }),
            },
          });
          await page.locator("openclaw-modal-dialog, .chat-error").first().waitFor();
          await page.screenshot({
            path: path.join(artifactDir, "selection-restriction.png"),
            animations: "disabled",
          });
          if (action === "mandatory" || action === "non-admin") {
            await expect
              .poll(() => pane.locator(".chat-error").textContent())
              .toContain("Choose another model");
            expect(
              await page
                .getByRole("button", { name: "Continue for this chat", exact: true })
                .count(),
            ).toBe(0);
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
            await modal
              .getByRole("button", {
                name: action === "confirm" ? "Continue for this chat" : "Cancel",
                exact: true,
              })
              .click();
            if (action === "confirm") {
              const retry = await gateway.waitForRequest("sessions.patch", {
                after: initialPatchCount,
              });
              expect(retry.params).toEqual({
                key,
                expectedSessionId: row.sessionId,
                model: "fixture/synthetic-model",
                agentRuntime: "opencode",
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
                agentRuntime: { id: "opencode", source: "session-key" },
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
                  providerOverride: "fixture",
                  modelOverride: row.model,
                  updatedAt: 2,
                },
                resolved: {
                  model: row.model,
                  modelProvider: "fixture",
                  agentRuntime: selected.agentRuntime,
                },
              });
              if (entrypoint === "send") {
                const resumed = await gateway.waitForRequest("chat.send", { after: 1 });
                expect(resumed.params).toMatchObject({
                  sessionKey: key,
                  message: "Keep this draft; do not send automatically.",
                  attachments: [{ fileName: "notes.txt" }],
                });
                assert(
                  isRecord(resumed.params) && typeof resumed.params.idempotencyKey === "string",
                );
                const runId = resumed.params.idempotencyKey;
                await gateway.resolveDeferred("chat.send", {
                  runId,
                  status: "started",
                });
                await gateway.emitChatFinal({
                  runId,
                  text: "Native retry completed.",
                });
                await pane
                  .locator(".chat-group.assistant")
                  .getByText("Native retry completed.", { exact: true })
                  .waitFor();
              }
              await expect.poll(() => trigger.getAttribute("aria-disabled")).toBe("false");
              await trigger.click();
              await expect
                .poll(() =>
                  picker
                    .locator('[data-chat-model-runtime="opencode"]')
                    .getAttribute("aria-selected"),
                )
                .toBe("true");
              await page.screenshot({
                path: path.join(artifactDir, "after-confirmed-selection.png"),
                animations: "disabled",
              });
            } else {
              await expect
                .poll(() => pane.locator(".chat-error").textContent())
                .toContain("Choose another model");
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
            entrypoint === "send" && action === "confirm"
              ? ""
              : "Keep this draft; do not send automatically.",
          );
          if (entrypoint === "send" && action !== "confirm") {
            expect(await composer.locator(".chat-attachment-thumb").count()).toBe(1);
            expect(await composer.locator(".chat-attachment-thumb").textContent()).toContain(
              "notes.txt",
            );
          }
        });
      },
    );
  });
});
