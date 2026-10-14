import { describe, expect, it } from "vitest";
import { sessionPlacementRecoveryExactStorageKey } from "../lib/sessions/session-placement-recovery-storage-key.ts";
import type { SessionPlacementPendingRecovery } from "../lib/sessions/session-placement-recovery.ts";
import type { ChatPageHost } from "../pages/chat/chat-state-host.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import {
  type createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";
import {
  controlUiSessionPath,
  createdSessionListResult,
  installMockGateway,
  waitForGatewayRecoveryScope,
} from "./new-session-page.test-support.ts";

export function holdRecoveryDigest() {
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
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
  describe("placement recovery module loading", () => {
    it.each(["none", "accepted", "invalid"] as const)(
      "resumes an unrelated offline queue after recovery releases it (%s)",
      async (recoveryKind) => {
        await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
          const sessionKey = "agent:main:release-recovery";
          const message = "original accepted turn";
          const messageId = "initial-release-attempt";
          const history = {
            messages:
              recoveryKind === "accepted"
                ? [
                    {
                      role: "user",
                      content: [{ type: "text", text: message }],
                      __openclaw: { idempotencyKey: `${messageId}:user` },
                    },
                  ]
                : [],
            sessionInfo: { hasActiveRun: false, status: "done" },
          };
          const gateway = await installMockGateway(page, {
            methodResponses: {
              "sessions.list": createdSessionListResult(sessionKey),
              "chat.history": history,
            },
          });
          await page.goto(`${suite.server.baseUrl}${controlUiSessionPath(sessionKey).slice(1)}`);
          const pane = page.locator(".chat-pane-cache__pane--active");
          const composer = page.locator(".agent-chat__composer-combobox textarea");
          await expect.poll(() => composer.isDisabled()).toBe(false);
          await waitForGatewayRecoveryScope(page);
          const owner = await evaluateControlUiContext(page, (context) => {
            const appGateway = context.gateway;
            return {
              gatewayUrl: appGateway.connection.gatewayUrl,
              recoveryScope: appGateway.snapshot.client!.recoveryScope,
            };
          });
          const recovery: SessionPlacementPendingRecovery = {
            ...owner,
            sessionKey,
            messageId,
            message,
            agentId: "main",
            target: { kind: "profile", profileId: "aws" },
            phase: "sending",
          };
          const storageKey = sessionPlacementRecoveryExactStorageKey(
            owner.gatewayUrl,
            owner.recoveryScope,
            sessionKey,
          );
          await gateway.setOnline(false);
          await expect
            .poll(() =>
              pane.evaluate(
                (element) => (element as HTMLElement & { state: ChatPageHost }).state.connected,
              ),
            )
            .toBe(false);
          await composer.fill("queued while offline");
          await composer.press("Enter");
          await page.locator(".chat-queue__item", { hasText: "queued while offline" }).waitFor();
          expect(await composer.inputValue()).toBe("");
          if (recoveryKind !== "none") {
            // Accepted retirement can fail to remove its sending row after the map owner
            // retires. A malformed target represents the reader's existing corruption boundary.
            await page.evaluate(
              ({ key, record }) => sessionStorage.setItem(key, JSON.stringify(record)),
              {
                key: storageKey,
                record:
                  recoveryKind === "invalid"
                    ? { ...recovery, target: { kind: "profile" } }
                    : recovery,
              },
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
            .poll(() =>
              pane.evaluate((element) => {
                const { state } = element as HTMLElement & { state: ChatPageHost };
                return state.connected && !state.client?.recoveryScopeReady && !state.chatLoading;
              }),
            )
            .toBe(true);
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          await page.evaluate(() =>
            (window as unknown as { releaseRecoveryDigest: () => void }).releaseRecoveryDigest(),
          );
          await runtime.request;
          if (recoveryKind !== "none") {
            expect(
              await pane.evaluate((element) => {
                const { state } = element as HTMLElement & { state: ChatPageHost };
                return (
                  state.client?.recoveryScopeReady &&
                  state.hasPendingInitialTurn?.(state.sessionKey)
                );
              }),
            ).toBe(true);
            expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          }
          const historyCount = (await gateway.getRequests("chat.history")).length;
          if (recoveryKind === "accepted") {
            await gateway.deferNext("chat.history");
          }
          runtime.release();
          if (recoveryKind === "accepted") {
            expect(
              await gateway.waitForRequest("chat.history", { after: historyCount }),
            ).toMatchObject({
              params: { sessionKey, limit: 1000 },
            });
            expect(await gateway.getRequests("chat.send")).toHaveLength(0);
            await gateway.resolveDeferred("chat.history", history);
          }
          await expect
            .poll(() => page.evaluate((key) => sessionStorage.getItem(key), storageKey))
            .toBeNull();
          await gateway.waitForRequest("chat.send");
          expect(await gateway.getRequests("chat.send")).toMatchObject([
            { params: { sessionKey, message: "queued while offline" } },
          ]);
          expect(await gateway.getRequests("sessions.send")).toHaveLength(0);
          expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
          if (recoveryKind === "accepted") {
            expect(await page.locator(".chat-group.user", { hasText: message }).count()).toBe(1);
          }
        });
      },
    );
  });
}
