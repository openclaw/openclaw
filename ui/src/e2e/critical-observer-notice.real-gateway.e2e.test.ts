// Real-Gateway proof for #137125: drives sessions.reset through the real
// Gateway's performGatewaySessionReset, then delivers a session.observer digest
// through the UI's event handler. The reset response comes from the real
// Gateway code path (not a mock); the observer digest is injected because a
// real observer event requires a provider-backed agent run, which this
// minimal Gateway does not provision.
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI critical observer notice real Gateway reset E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const selectedSessionKey = "agent:main:selected";
const backgroundSessionKey = "agent:main:other";
const baseTime = Date.parse("2026-07-25T18:00:00.000Z");

function observerDigest(params: {
  sessionKey: string;
  health: "on-track" | "stuck";
  revision: number;
  headline: string;
}) {
  return {
    sessionKey: params.sessionKey,
    runId: `observer-run-${params.sessionKey}`,
    updatedAt: baseTime + params.revision,
    headline: params.headline,
    health: params.health,
    revision: params.revision,
  };
}

// Inject a session.observer event through the UI's gateway event handler.
// The real Gateway broadcasts these as WebSocket event frames; here we call
// the same handler directly because a real observer event requires a
// provider-backed agent run (not provisioned by this minimal Gateway).
async function emitObserverAndReadToast(
  page: Page,
  payload: ReturnType<typeof observerDigest>,
  action?: "dismiss",
): Promise<{ message: string; visible: boolean }> {
  return await page.locator("openclaw-toast-host").evaluate(
    async (element, params) => {
      const host = element as HTMLElement & { updateComplete: Promise<unknown> };
      const app = document.querySelector("openclaw-app-shell") as
        | (HTMLElement & {
            handleGatewayEvent?: (event: {
              type: "event";
              event: string;
              payload?: unknown;
            }) => void;
            criticalNoticeRuntime?: Promise<unknown> | null;
          })
        | null;
      if (!app?.handleGatewayEvent) {
        throw new Error("App shell gateway event handler is unavailable");
      }
      app.handleGatewayEvent({ type: "event", event: "session.observer", payload: params.payload });
      const runtime = app.criticalNoticeRuntime;
      if (!runtime) {
        throw new Error("Critical observer notice runtime did not start");
      }
      await runtime;
      await host.updateComplete;

      const toast = host.querySelector<HTMLElement>(".app-toast");
      const isVisible = (target: HTMLElement | null): target is HTMLElement => {
        if (!target?.isConnected) {
          return false;
        }
        const style = getComputedStyle(target);
        const bounds = target.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          bounds.width > 0 &&
          bounds.height > 0
        );
      };
      const visible = isVisible(toast);
      const result = () => ({
        message: toast?.querySelector(".app-toast__message")?.textContent ?? "",
        visible,
      });
      if (params.action === "dismiss" && visible) {
        const button = toast?.querySelector<HTMLButtonElement>(".app-toast__dismiss");
        if (button) {
          button.click();
        }
        await host.updateComplete;
      }
      return result();
    },
    { action, payload },
  );
}

suite.define(() => {
  it("real-Gateway /clear resets the critical-notice floor so a new lifecycle revision 1 announces (#137125)", async (context) => {
    const artifactDir = createControlUiE2eArtifactDir("critical-observer-notice-real-gateway");
    let fixture: OpenClawTestState | undefined;
    let gateway: GatewayServer | undefined;
    await suite.runScenario(context, {
      retainedState: () => fixture?.root,
      close: async () => {
        await gateway?.close({ reason: "critical observer notice real gateway e2e cleanup" });
      },
      release: async () => {
        await fixture?.cleanup();
      },
      run: async (signal) => {
        const port = await getFreePort();
        signal.throwIfAborted();
        const state = await createOpenClawTestState({
          label: "control-ui-critical-notice-real-gateway",
          env: {
            OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
            OPENCLAW_SKIP_CANVAS_HOST: "1",
            OPENCLAW_SKIP_CHANNELS: "1",
            OPENCLAW_SKIP_CRON: "1",
            OPENCLAW_SKIP_GMAIL_WATCHER: "1",
            OPENCLAW_SKIP_PROVIDERS: "1",
            OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
            VITEST: "1",
          },
        });
        fixture = state;
        signal.throwIfAborted();

        const { upsertSessionEntryCore, persistSessionTranscriptTurn } =
          await import("../../../src/config/sessions/session-accessor.js");

        signal.throwIfAborted();
        await state.writeConfig({
          agents: {
            ownership: "explicit",
            defaults: { workspace: state.workspaceDir },
            entries: {
              main: { workspace: state.workspaceDir },
            },
          },
          gateway: {
            mode: "local",
            port,
            bind: "loopback",
            auth: { mode: "none" },
            controlUi: { enabled: false },
          },
          plugins: { enabled: false },
          session: {
            store: path.join(state.stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
          },
        });

        // Seed two sessions: a selected (foreground) session and a background
        // session. The background session is the one whose critical-notice floor
        // must be retired by /clear.
        const sessionId = "crit-notice-proof";
        for (const [key, label] of [
          [selectedSessionKey, "Main session"],
          [backgroundSessionKey, "Background investigation"],
        ] as const) {
          signal.throwIfAborted();
          const scope = {
            agentId: "main",
            sessionId,
            sessionKey: key,
            storePath: path.join(state.sessionsDir("main"), "sessions.json"),
          };
          await upsertSessionEntryCore(scope, {
            sessionId,
            label,
            updatedAt: baseTime,
          });
          await persistSessionTranscriptTurn(scope, {
            cwd: state.workspaceDir,
            updateMode: "none",
            messages: [
              {
                message: { role: "user", content: `${label} is ready.`, timestamp: baseTime },
                now: baseTime,
              },
            ],
          });
        }

        signal.throwIfAborted();
        const { startGatewayServer } = await import("../../../src/gateway/server.js");
        gateway = await startGatewayServer(port, {
          auth: { mode: "none" },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        });
        signal.throwIfAborted();

        await suite.withPage(
          {
            locale: "en-US",
            serviceWorkers: "block",
            viewport: { height: 900, width: 1440 },
          },
          async ({ page }) => {
            const url = new URL(
              controlUiSessionUrl(suite.server.baseUrl, selectedSessionKey, "chat"),
            );
            url.searchParams.set("gatewayUrl", `ws://127.0.0.1:${port}`);
            await page.goto(url.toString());
            const confirmation = page.locator("openclaw-gateway-url-confirmation");
            await confirmation.waitFor();
            await confirmation.getByRole("button", { name: "Confirm", exact: true }).click();
            await waitForControlUiGatewayReady(page);
            await page.getByText("Main session is ready.").waitFor({ state: "visible" });

            // Step 1: background session emits a critical digest at revision 10.
            const preResetHeadline = "Background investigation is stuck";
            const preResetToast = await emitObserverAndReadToast(
              page,
              observerDigest({
                sessionKey: backgroundSessionKey,
                health: "stuck",
                headline: preResetHeadline,
                revision: 10,
              }),
              "dismiss",
            );
            expect(preResetToast.visible).toBe(true);
            expect(preResetToast.message).toContain(preResetHeadline);
            await page.screenshot({
              fullPage: true,
              path: path.join(artifactDir, "01-pre-reset-revision-10-toast.png"),
            });

            // Step 2: trigger sessions.reset through the production session
            // capability. The real Gateway's performGatewaySessionReset handles
            // this — not a mock.
            const resetResult = await page.evaluate(async (targetKey) => {
              const app = document.querySelector("openclaw-app-shell") as
                | (HTMLElement & {
                    context?: {
                      sessions?: {
                        reset: (key: string, opts?: { agentId?: string }) => Promise<string>;
                      };
                    };
                  })
                | null;
              if (!app?.context?.sessions) {
                throw new Error("Session capability is unavailable");
              }
              return app.context.sessions.reset(targetKey);
            }, backgroundSessionKey);
            expect(resetResult).toBe("completed");

            // Step 3: the reset session's new lifecycle emits revision 1 —
            // without the fix this is silently rejected against the retained
            // floor of 10.
            const postResetHeadline = "Background investigation is stuck again";
            const postResetToast = await emitObserverAndReadToast(
              page,
              observerDigest({
                sessionKey: backgroundSessionKey,
                health: "stuck",
                headline: postResetHeadline,
                revision: 1,
              }),
            );
            expect(postResetToast.visible).toBe(true);
            expect(postResetToast.message).toContain(postResetHeadline);
            await page.screenshot({
              fullPage: true,
              path: path.join(artifactDir, "02-post-reset-revision-1-toast.png"),
            });
          },
        );
      },
    });
  });
});
