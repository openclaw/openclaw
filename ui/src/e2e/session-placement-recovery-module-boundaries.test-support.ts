import { expect, it } from "vitest";
import { sessionPlacementRecoveryExactStorageKey as recoveryStorageKey } from "../lib/sessions/session-placement-recovery-storage-key.ts";
import type { SessionPlacementPendingRecovery } from "../lib/sessions/session-placement-recovery.ts";
import type { ChatPageHost } from "../pages/chat/chat-state-host.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { chatMessage, controlUiSessionUrl } from "./chat-flow.test-support.ts";
import {
  type createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";
import {
  createdSessionListResult,
  installMockGateway,
  waitForGatewayRecoveryScope,
} from "./new-session-page.test-support.ts";
import { expectNoRequests } from "./session-management.compact.test-support.ts";

export function holdRecoveryDigest() {
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  const { promise: ready, resolve: release } = Promise.withResolvers<void>();
  Object.assign(window, { releaseRecoveryDigest: release });
  crypto.subtle.digest = async (algorithm, data) => {
    const result = await digest(algorithm, data);
    if (new TextDecoder().decode(data) === "e2e-device-token") {
      await ready;
    }
    return result;
  };
}

export function defineSessionPlacementRecoveryModuleBoundaryTests(
  suite: ReturnType<typeof createControlUiE2eSuite>,
  moduleRequest: (sourcePath: string) => RegExp,
) {
  it.each(["none", "accepted", "invalid"] as const)(
    "placement recovery module loading resumes an unrelated offline queue (%s)",
    async (recoveryKind) => {
      await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
        const sessionKey = "agent:main:release-recovery";
        const sessionId = `session:${sessionKey}`;
        const message = "original accepted turn";
        const messageId = "initial-release-attempt";
        const accepted = chatMessage("user", message, {
          __openclaw: { idempotencyKey: `${messageId}:user` },
        });
        const history = {
          sessionId,
          messages: recoveryKind === "accepted" ? [accepted] : [],
          sessionInfo: { key: sessionKey, sessionId, hasActiveRun: false, status: "done" },
        };
        const gateway = await installMockGateway(page, {
          // The offline reload below must return before this test reconnects.
          awaitInitialRoster: false,
          methodResponses: {
            "sessions.list": createdSessionListResult(sessionKey),
            "chat.history": history,
            "chat.send": {
              cases: [
                {
                  match: { idempotencyKey: messageId },
                  response: { runId: messageId, status: "ok" },
                },
              ],
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const pane = page.locator(".chat-pane-cache__pane--active");
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        const requests = gateway.getRequests;
        const connection = () =>
          pane.evaluate((element: HTMLElement & { state: ChatPageHost }) => ({
            connected: element.state.connected,
            ready: Boolean(element.state.client?.recoveryScopeReady),
            loading: element.state.chatLoading,
          }));
        await expect.poll(() => composer.isDisabled()).toBe(false);
        await waitForGatewayRecoveryScope(page);
        const owner = await evaluateControlUiContext(page, ({ gateway: appGateway }) => ({
          gatewayUrl: appGateway.connection.gatewayUrl,
          recoveryScope: appGateway.snapshot.client!.recoveryScope,
        }));
        const recovery: SessionPlacementPendingRecovery = {
          ...owner,
          sessionKey,
          sessionId,
          messageId,
          message,
          agentId: "main",
          target: { kind: "profile", profileId: "aws" },
          phase: "sending",
        };
        const storageKey = recoveryStorageKey(owner.gatewayUrl, owner.recoveryScope, sessionKey);
        await gateway.setOnline(false);
        await expect.poll(connection).toMatchObject({ connected: false });
        await composer.fill("queued while offline");
        await composer.press("Enter");
        await page.locator(".chat-queue__item", { hasText: "queued while offline" }).waitFor();
        expect(await composer.inputValue()).toBe("");
        if (recoveryKind !== "none") {
          // Accepted retirement can fail to remove its sending row after the map owner
          // retires. A malformed target represents the reader's existing corruption boundary.
          const recoveryRecord =
            recoveryKind === "invalid" ? { ...recovery, target: { kind: "profile" } } : recovery;
          await page.evaluate(
            ({ key, record }) => sessionStorage.setItem(key, JSON.stringify(record)),
            { key: storageKey, record: recoveryRecord },
          );
        }
        await page.addInitScript(holdRecoveryDigest);
        await page.reload();
        const runtime = await holdModuleResponse(
          page,
          moduleRequest("ui/src/app/session-placement-startup.runtime.ts"),
        );
        await gateway.setOnline(true);
        await expect
          .poll(connection)
          .toMatchObject({ connected: true, ready: false, loading: false });
        await expectNoRequests(gateway, "chat.send");
        await page.evaluate(() =>
          (window as unknown as { releaseRecoveryDigest: () => void }).releaseRecoveryDigest(),
        );
        if (recoveryKind !== "none") {
          await runtime.request;
          expect(
            await pane.evaluate(
              ({ state }: HTMLElement & { state: ChatPageHost }) =>
                state.client?.recoveryScopeReady && state.hasPendingInitialTurn?.(state.sessionKey),
            ),
          ).toBe(true);
          await expectNoRequests(gateway, "chat.send");
        }
        if (recoveryKind === "accepted") {
          await gateway.deferNext("chat.send");
        }
        runtime.release();
        if (recoveryKind === "accepted") {
          expect(await gateway.waitForRequest("chat.send")).toMatchObject({
            params: { sessionKey, sessionId, expectedLeafEntryId: null, idempotencyKey: messageId },
          });
          expect(await requests("chat.send")).toHaveLength(1);
          await gateway.resolveDeferred("chat.send", { runId: messageId, status: "ok" });
        }
        await expect
          .poll(() => page.evaluate((key) => sessionStorage.getItem(key), storageKey))
          .toBeNull();
        await gateway.waitForRequest("chat.send", { after: recoveryKind === "accepted" ? 1 : 0 });
        expect(await requests("chat.send")).toMatchObject([
          ...(recoveryKind === "accepted"
            ? [{ params: { sessionKey, sessionId, idempotencyKey: messageId } }]
            : []),
          { params: { sessionKey, message: "queued while offline" } },
        ]);
        expect(await requests("chat.send")).toHaveLength(recoveryKind === "accepted" ? 2 : 1);
        expect(runtime.requests()).toBe(recoveryKind === "none" ? 0 : 1);
        await expectNoRequests(gateway, "sessions.dispatch");
        if (recoveryKind === "accepted") {
          expect(await page.locator(".chat-group.user", { hasText: message }).count()).toBe(1);
        }
      });
    },
  );
}
