import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it, vi } from "vitest";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import { resetLogger, setLoggerOverride } from "../../../src/logging/logger.ts";
import type { SessionsUsageResult } from "../../../src/shared/usage-types.ts";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import type { ApplicationContext } from "../app/context.ts";
import { COMMUNITY_INVITE_KEY } from "../components/community-invite-state.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI usage sessions owner attribution",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const viewport = { height: 900, width: 1_440 };

const PROOF_SESSION_ID = "tg-dm-owner-attribution-proof";
const PROOF_STORE_KEY = "agent:main:telegram:dm";
const PROOF_LABEL = "Telegram DM";

async function capture(page: Page, name: string) {
  if (!captureUiProof) {
    return;
  }
  expect(await page.locator(".community-invite-card").count()).toBe(0);
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(suite.artifactDir, name),
  });
}

async function prepareUsageProofPage(page: Page) {
  await page.addInitScript((key) => {
    window.localStorage.setItem(key, JSON.stringify({ dismissedAtMs: 1770000000000 }));
  }, COMMUNITY_INVITE_KEY);
}

async function requestGateway<T>(
  page: Page,
  methodName: string,
  requestParams: Record<string, unknown>,
) {
  return await page.evaluate(
    async ({ method, params }) => {
      const app = document.querySelector("openclaw-app") as
        | (HTMLElement & { runtime?: { context: ApplicationContext } })
        | null;
      const client = app?.runtime?.context.gateway.snapshot.client;
      if (!client) {
        throw new Error("Usage proof has no connected Gateway client");
      }
      return await client.request<T>(method, params);
    },
    { method: methodName, params: requestParams },
  );
}

suite.define(() => {
  it.for([false, true])(
    "keeps same-id owners separate with an empty current session: %s",
    async (resetCurrentSession, context) => {
      let fixture: OpenClawTestState | undefined;
      let gateway: Promise<GatewayServer> | undefined;
      await suite.runScenario(context, {
        retainedState: () => fixture?.root,
        close: async () => {
          const server = await gateway;
          await server?.close({ reason: "usage sessions owner attribution e2e cleanup" });
        },
        release: async () => {
          await fixture?.cleanup();
          resetLogger();
        },
        run: async (signal) => {
          const port = await getFreePort();
          signal.throwIfAborted();
          const state = await createOpenClawTestState({
            label: "usage-sessions-owner-attribution",
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
          setLoggerOverride({
            file: state.path("gateway.log"),
            level: "silent",
            consoleLevel: "silent",
          });
          signal.throwIfAborted();

          const { startGatewayServer } = await import("../../../src/gateway/server.js");
          signal.throwIfAborted();
          const { persistSessionTranscriptTurn, upsertSessionEntryCore } =
            await import("../../../src/config/sessions/session-accessor.js");

          signal.throwIfAborted();
          await state.writeConfig({
            agents: {
              ownership: "explicit",
              defaults: { workspace: state.workspaceDir },
              entries: {
                main: { workspace: state.workspaceDir },
                opus: { workspace: state.workspaceDir },
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

          for (const agentId of ["main", "opus"]) {
            signal.throwIfAborted();
            const scope = {
              agentId,
              sessionId: PROOF_SESSION_ID,
              sessionKey: agentId === "main" ? PROOF_STORE_KEY : `agent:opus:${PROOF_SESSION_ID}`,
              storePath: path.join(state.sessionsDir(agentId), "sessions.json"),
            };
            const now = Date.now();
            if (agentId === "main") {
              await upsertSessionEntryCore(scope, {
                sessionId: PROOF_SESSION_ID,
                label: PROOF_LABEL,
                updatedAt: now,
              });
            }
            signal.throwIfAborted();
            // Both transcripts must fall inside the dashboard's current date window.
            await persistSessionTranscriptTurn(scope, {
              cwd: state.workspaceDir,
              updateMode: "none",
              messages: [
                { message: { role: "user", content: `${agentId} turn`, timestamp: now }, now },
              ],
            });
          }

          signal.throwIfAborted();
          if (resetCurrentSession) {
            await upsertSessionEntryCore(
              {
                agentId: "main",
                sessionKey: PROOF_STORE_KEY,
                storePath: path.join(state.sessionsDir("main"), "sessions.json"),
              },
              {
                sessionId: "empty-current-session",
                label: PROOF_LABEL,
                updatedAt: Date.now(),
              },
            );
          }

          signal.throwIfAborted();
          gateway = startGatewayServer(port, {
            auth: { mode: "none" },
            bind: "loopback",
            controlUiEnabled: false,
            sidecarStartup: "defer",
          });
          await gateway;
          signal.throwIfAborted();

          await suite.withPage(
            {
              locale: "en-US",
              serviceWorkers: "block",
              viewport,
            },
            async ({ page }) => {
              await prepareUsageProofPage(page);
              const pageErrors: string[] = [];
              page.on("pageerror", (error) => pageErrors.push(String(error)));

              const url = new URL("usage", suite.server.baseUrl);
              url.searchParams.set("gatewayUrl", `ws://127.0.0.1:${port}`);
              await page.goto(url.toString());
              const confirmation = page.locator("openclaw-gateway-url-confirmation");
              await confirmation.waitFor();
              await confirmation
                .getByRole("button", { name: `Switch to 127.0.0.1:${port}`, exact: true })
                .click();

              const otherRow = page.locator(
                `.session-bar-row[title="agent:opus:${PROOF_SESSION_ID}"]`,
              );
              // A rendered usage row proves the handshake and requested report both arrived.
              await otherRow.waitFor();
              await expect.poll(() => otherRow.count()).toBe(1);
              await otherRow.scrollIntoViewIfNeeded();
              await capture(page, "01-other-owner.png");

              // The named family stays visible before its new current instance has a transcript.
              const row = page.locator(`.session-bar-row[title="${PROOF_STORE_KEY}"]`);
              await row.waitFor();
              await expect.poll(() => row.count()).toBe(1);
              const meta = row.locator(".session-bar-meta");
              await expect
                .poll(async () => (await meta.textContent()) ?? "")
                .toContain("agent:main");
              await expect
                .poll(async () => (await meta.textContent()) ?? "")
                .not.toContain("agent:opus");
              await expect
                .poll(() => otherRow.locator(".session-bar-meta").textContent())
                .toContain("agent:opus");
              await expect.poll(() => page.locator(".session-bar-row").count()).toBe(2);

              await row.scrollIntoViewIfNeeded();
              await capture(page, "02-current-owner.png");
              expect(pageErrors).toEqual([]);
            },
          );
        },
      });
    },
  );

  it("replaces selected details when the same agent recreates a deleted session key", async (context) => {
    let fixture: OpenClawTestState | undefined;
    let gateway: Promise<GatewayServer> | undefined;
    let restoreClock: (() => void) | undefined;
    await suite.runScenario(context, {
      retainedState: () => fixture?.root,
      close: async () => {
        await (await gateway)?.close({ reason: "usage detail instance e2e cleanup" });
      },
      release: async () => {
        restoreClock?.();
        await fixture?.cleanup();
        resetLogger();
      },
      run: async (signal) => {
        const port = await getFreePort();
        signal.throwIfAborted();
        const state = await createOpenClawTestState({
          label: "usage-detail-instance",
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
        setLoggerOverride({
          file: state.path("gateway.log"),
          level: "silent",
          consoleLevel: "silent",
        });
        signal.throwIfAborted();
        await state.writeConfig({
          agents: {
            ownership: "explicit",
            defaults: { workspace: state.workspaceDir },
            entries: { main: {}, opus: {} },
          },
          gateway: {
            mode: "local",
            port,
            bind: "loopback",
            auth: { mode: "none" },
            controlUi: { enabled: false },
          },
          plugins: { enabled: false },
        });
        const { startGatewayServer } = await import("../../../src/gateway/server.js");
        const { persistSessionTranscriptTurn } =
          await import("../../../src/config/sessions/session-accessor.js");
        const { ensureGatewayOwnerProfile } = await import("../../../src/state/user-profiles.js");
        ensureGatewayOwnerProfile("Usage Proof", { env: state.env });
        signal.throwIfAborted();
        gateway = startGatewayServer(port, {
          auth: { mode: "none" },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        });
        await gateway;
        signal.throwIfAborted();

        await suite.withPage(
          { locale: "en-US", timezoneId: "UTC", serviceWorkers: "block", viewport },
          async ({ page }) => {
            await prepareUsageProofPage(page);
            const key = "agent:opus:usage-instance-proof";
            const gatewayUrl = new URL(`ws://127.0.0.1:${port}`).href;
            const pageErrors: string[] = [];
            const overviewRequests = new Map<string, Record<string, unknown>>();
            const observedOverviews: Array<{
              requestId: string;
              params: Record<string, unknown>;
              session?: { key: string; agentId?: string; sessionId?: string; tokens?: number };
            }> = [];
            let connections = 0;
            page.on("pageerror", (error) => pageErrors.push(String(error)));
            page.on("websocket", (socket) => {
              if (socket.url() !== gatewayUrl) {
                return;
              }
              connections++;
              socket.on("framesent", ({ payload }) => {
                const frame: {
                  type: string;
                  id: string;
                  method?: string;
                  params?: Record<string, unknown>;
                } = JSON.parse(payload.toString());
                if (
                  frame.type === "req" &&
                  frame.method === "sessions.usage" &&
                  frame.params &&
                  frame.params.key === undefined
                ) {
                  overviewRequests.set(frame.id, frame.params);
                }
              });
              socket.on("framereceived", ({ payload }) => {
                const frame: {
                  type: string;
                  id: string;
                  ok?: boolean;
                  payload?: SessionsUsageResult;
                } = JSON.parse(payload.toString());
                const params = overviewRequests.get(frame.id);
                if (frame.type !== "res" || !frame.ok || !params || !frame.payload) {
                  return;
                }
                const session = frame.payload.sessions.find((entry) => entry.key === key);
                observedOverviews.push({
                  requestId: frame.id,
                  params,
                  ...(session
                    ? {
                        session: {
                          key: session.key,
                          agentId: session.agentId,
                          sessionId: session.sessionId,
                          tokens: session.usage?.totalTokens,
                        },
                      }
                    : {}),
                });
              });
            });
            const url = new URL("settings/general", suite.server.baseUrl);
            url.searchParams.set("gatewayUrl", gatewayUrl);
            await page.goto(url.toString());
            await page
              .locator("openclaw-gateway-url-confirmation")
              .getByRole("button", { name: `Switch to 127.0.0.1:${port}`, exact: true })
              .click();
            await waitForControlUiGatewayReady(page);

            const date = new Date().toISOString().slice(0, 10);
            const timestamp = Date.parse(`${date}T12:00:00Z`);
            const createSession = async (label: string, tokens: number) => {
              const created = await requestGateway<{ ok: boolean; key: string; sessionId: string }>(
                page,
                "sessions.create",
                { key, agentId: "opus", label: `${label} usage session` },
              );
              expect(created.ok).toBe(true);
              expect(created.key).toBe(key);
              expect(created.sessionId).toBeTruthy();
              signal.throwIfAborted();
              await persistSessionTranscriptTurn(
                { agentId: "opus", sessionKey: key, sessionId: created.sessionId, env: state.env },
                {
                  cwd: state.workspaceDir,
                  updateMode: "none",
                  messages: [0, 1].map((index) => ({
                    now: timestamp + index * 1_000,
                    message: {
                      role: "assistant",
                      content: [{ type: "text", text: `${label} reply ${index + 1}` }],
                      api: "openai-responses",
                      provider: "fixture",
                      model: "usage-proof",
                      stopReason: "stop",
                      timestamp: timestamp + index * 1_000,
                      usage: {
                        input: tokens,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        totalTokens: tokens,
                        cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
                      },
                    },
                  })),
                },
              );
              return created.sessionId;
            };
            const originalId = await createSession("Original", 100);
            await page.goto(new URL("usage", suite.server.baseUrl).toString());
            await waitForControlUiGatewayReady(page);
            const selected = page.locator(
              `.session-bar-row[title="${key}"] .session-bar-selection`,
            );
            await selected.click();
            const panel = page.locator(".session-detail-panel");
            const readDetails = async () => ({
              timeline: await panel.locator(".timeseries-summary").textContent(),
              conversation: await panel.locator(".session-log-content").allTextContents(),
            });
            await expect.poll(readDetails).toEqual({
              timeline: expect.stringContaining("200"),
              conversation: ["Original reply 1", "Original reply 2"],
            });
            const initialOverview = observedOverviews.findLast(
              (overview) => overview.session?.sessionId === originalId,
            );
            if (!initialOverview) {
              throw new Error("The Usage page did not receive its original session overview");
            }
            await capture(page, "01-original-instance-details.png");
            const selectedConnections = connections;

            const deleted = await requestGateway<{ deleted: boolean }>(page, "sessions.delete", {
              key,
              agentId: "opus",
              expectedSessionId: originalId,
              deleteTranscript: true,
            });
            expect(deleted.deleted).toBe(true);
            const replacementId = await createSession("Replacement", 300);
            expect(replacementId).not.toBe(originalId);

            // Age the real cache without replacing its loader or advancing asynchronous timers.
            const realNow = Date.now.bind(Date);
            const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + 31_000);
            restoreClock = () => clock.mockRestore();
            const overviewParams = initialOverview.params;
            // The first stale-while-refresh read may still return the retired instance.
            await expect
              .poll(async () => {
                const overview = await requestGateway<SessionsUsageResult>(
                  page,
                  "sessions.usage",
                  overviewParams,
                );
                const current = overview.sessions.find((session) => session.key === key);
                return { sessionId: current?.sessionId, tokens: current?.usage?.totalTokens };
              })
              .toEqual({ sessionId: replacementId, tokens: 600 });
            const focusOverviewStart = observedOverviews.length;

            // Keep the real connection active while aging the browser's five-minute focus TTL.
            const browserNow = await page.evaluate(() => Date.now());
            for (let step = 1; step <= 31; step++) {
              await page.clock.setFixedTime(new Date(browserNow + step * 10_000));
              await requestGateway(page, "health", {});
            }
            await page.bringToFront();
            await page.evaluate(() => window.dispatchEvent(new Event("focus")));
            await expect
              .poll(() => panel.locator(".session-detail-title").textContent())
              .toContain("Replacement usage session");
            await expect
              .poll(() => panel.locator(".session-detail-stats").textContent())
              .toContain("600");
            const selectedReplacement = page.locator(
              ".session-bar-row.selected .session-bar-selection",
            );
            expect(await selectedReplacement.count()).toBe(1);
            expect(await selectedReplacement.getAttribute("aria-pressed")).toBe("true");
            expect(await selectedReplacement.getAttribute("aria-label")).toBe(
              "Replacement usage session",
            );
            expect(
              observedOverviews
                .slice(focusOverviewStart)
                .some((overview) => overview.session?.sessionId === replacementId),
            ).toBe(true);
            expect(connections).toBe(selectedConnections);
            try {
              await expect.poll(readDetails).toEqual({
                timeline: expect.stringContaining("600"),
                conversation: ["Replacement reply 1", "Replacement reply 2"],
              });
            } finally {
              await capture(page, "02-replacement-instance-details.png");
              await panel.locator(".session-log-content").last().scrollIntoViewIfNeeded();
              await capture(page, "03-replacement-instance-conversation.png");
              if (captureUiProof) {
                await writeFile(
                  path.join(suite.artifactDir, "instance-replacement.json"),
                  JSON.stringify({
                    key,
                    agentId: "opus",
                    originalId,
                    replacementId,
                    selection: {
                      pressed: await selectedReplacement.getAttribute("aria-pressed"),
                      label: await selectedReplacement.getAttribute("aria-label"),
                    },
                    initialOverview,
                    focusOverviews: observedOverviews.slice(focusOverviewStart),
                    selectedConnections,
                    connections,
                    ...(await readDetails()),
                  }),
                );
              }
            }
            expect(connections).toBe(selectedConnections);
            expect(pageErrors).toEqual([]);
          },
        );
      },
    });
  });
});
