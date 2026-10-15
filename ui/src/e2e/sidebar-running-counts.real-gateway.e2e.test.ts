import { writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { expect, it } from "vitest";
import { replaceSessionEntrySync } from "../../../src/config/sessions/session-accessor.ts";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import { emitAgentEvent } from "../../../src/infra/agent-events.ts";
import {
  clearAgentRunContext,
  claimAgentRunContext,
  releaseAgentRunContext,
} from "../../../src/infra/agent-run-registry.ts";
import { setDisplayName } from "../../../src/state/user-profile-writes.worker.ts";
import { ensureProfileForEmail } from "../../../src/state/user-profiles.ts";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { COMMUNITY_INVITE_KEY } from "../components/community-invite-state.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import {
  waitForControlUiGatewayReady,
  waitForControlUiInitialRoster,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

declare global {
  interface Window {
    recordSidebarRunEvent: (sessionKey: string, active: boolean) => Promise<void>;
  }
}

const suite = createControlUiE2eSuite({
  name: "Sidebar running counts with a real Gateway",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("refreshes a person's running count for work outside the loaded agent and summary page", async () => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "sidebar-running-counts",
      layout: "home",
      env: {
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
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
    let gateway: GatewayServer | undefined;
    let proxy: ViteDevServer | undefined;
    const keys = Array.from({ length: 12 }, (_, i) => "agent:work:count-proof-" + i);
    const runIds = keys.map((_, i) => "count-proof-run-" + i);
    const claims = new Map<string, string | undefined>();
    try {
      const email = "count-proof@example.test";
      const profile = ensureProfileForEmail(email);
      setDisplayName(profile.id, "Test Person");
      const workspace = state.path("workspace-work");
      await mkdir(workspace, { recursive: true });
      const trustedProxy = {
        allowLoopback: true,
        allowUsers: [email],
        deviceAutoApprove: {
          enabled: true,
          scopes: ["operator.admin", "operator.read", "operator.write"],
        },
        requiredHeaders: ["x-forwarded-proto"],
        userHeader: "x-forwarded-user",
      };
      await state.writeConfig({
        agents: {
          ownership: "explicit",
          defaults: { workspace: state.workspaceDir, model: { primary: "fixture/count-proof" } },
          entries: {
            main: { name: "Main", workspace: state.workspaceDir },
            work: { name: "Work", workspace },
          },
        },
        gateway: {
          auth: { mode: "trusted-proxy", trustedProxy },
          controlUi: { allowedOrigins: [new URL(suite.server.baseUrl).origin], enabled: false },
          port,
          trustedProxies: ["127.0.0.1", "::1"],
        },
      });
      state.applyEnv();
      const now = Date.now();
      for (const [index, key] of [...keys, "agent:main:main"].entries()) {
        replaceSessionEntrySync(
          { agentId: key.startsWith("agent:work:") ? "work" : "main", sessionKey: key },
          {
            sessionId: "count-proof-session-" + index,
            updatedAt: now - (keys.length - index) * 1_000,
            label: index === keys.length ? "Count proof" : "Background work " + (index + 1),
            visibility: "shared",
            createdActor: { type: "human", source: "profile", id: profile.id },
          },
        );
      }
      const { startGatewayServer } = await import("../../../src/gateway/server.js");
      gateway = await startGatewayServer(port, {
        auth: { mode: "trusted-proxy", trustedProxy },
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });
      proxy = await createServer({
        configFile: false,
        envFile: false,
        root: state.workspaceDir,
        appType: "custom",
        logLevel: "error",
        server: {
          host: "127.0.0.1",
          port: 0,
          proxy: {
            "/": {
              target: "http://127.0.0.1:" + port,
              ws: true,
              headers: {
                "x-forwarded-for": "192.0.2.10",
                "x-forwarded-proto": "http",
                "x-forwarded-user": email,
              },
            },
          },
        },
      });
      await proxy.listen();
      const proxyUrl = proxy.resolvedUrls?.local[0];
      if (!proxyUrl) {
        throw new Error("Count proof proxy did not expose a loopback URL");
      }
      const gatewayUrl = new URL(proxyUrl);
      gatewayUrl.protocol = "ws:";
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 800 } },
        async ({ page }) => {
          await page.addInitScript(
            (key) => localStorage.setItem(key, "dismissed"),
            COMMUNITY_INVITE_KEY,
          );
          const activeEvents = new Set<string>();
          const stoppedEvents = new Set<string>();
          const url = new URL(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
          url.hash = new URLSearchParams({ gatewayUrl: gatewayUrl.href }).toString();
          await page.goto(url.href);
          await page
            .locator("openclaw-gateway-url-confirmation")
            .getByRole("button", { name: "Switch to " + gatewayUrl.host, exact: true })
            .click();
          await waitForControlUiGatewayReady(page);
          await waitForControlUiInitialRoster(page);
          await page.screenshot({ path: path.join(suite.artifactDir, "initial-shell.png") });
          await page.locator('[data-navigation-view="online"]').click();
          const person = page.locator('[data-online-user-id="' + profile.id + '"]');
          await expect
            .poll(() => person.getAttribute("aria-description"))
            .toContain("13 open sessions, 0 running");
          await page.exposeFunction(
            "recordSidebarRunEvent",
            (sessionKey: string, active: boolean) => {
              if (keys.includes(sessionKey)) {
                (active ? activeEvents : stoppedEvents).add(sessionKey);
              }
            },
          );
          await evaluateControlUiContext(page, (context) => {
            // Observe after the app's consumers have installed their debounce,
            // not merely after CDP receives the raw WebSocket frame.
            context.gateway.subscribeEvents((event) => {
              const payload = event.payload as
                | { sessionKey?: string; session?: { hasActiveRun?: boolean } }
                | undefined;
              if (
                event.event === "sessions.changed" &&
                typeof payload?.sessionKey === "string" &&
                typeof payload.session?.hasActiveRun === "boolean"
              ) {
                void window.recordSidebarRunEvent(payload.sessionKey, payload.session.hasActiveRun);
              }
            });
          });
          await page.clock.install();
          await pauseVirtualClock(page);
          const clockStartedAt = await page.evaluate(() => Date.now());
          // Real runtime owners produce the liveness and sessions.changed events;
          // no mocked count response or paid inference is involved.
          for (const [index, key] of keys.entries()) {
            claims.set(
              runIds[index]!,
              claimAgentRunContext(
                runIds[index]!,
                {
                  sessionKey: key,
                  sessionId: "count-proof-session-" + index,
                  agentId: "work",
                  projectSessionActive: true,
                },
                { trackOwner: true, ownsContext: true },
              ),
            );
            emitAgentEvent({
              runId: runIds[index]!,
              sessionKey: key,
              stream: "lifecycle",
              data: { phase: "start", startedAt: Date.now() },
            });
          }
          await expect.poll(() => activeEvents.size).toBe(12);
          await page.clock.runFor(5_000);
          await page.mouse.move(900, 600);
          try {
            await expect
              .poll(async () => {
                // Real count replies can arrive after the collection-window jump.
                // Drain their presentation frame without resuming fallback timers.
                await page.clock.runFor(20);
                return person.getAttribute("aria-description");
              })
              .toContain("13 open sessions, 12 running");
          } finally {
            const frame = await takeControlUiScreenshotFrame(
              page,
              page.locator(".sidebar"),
              [person],
              {
                animations: "disabled",
                elements: [page.locator(".sidebar")],
              },
            );
            writeFileSync(
              path.join(suite.artifactDir, "running-count.png"),
              frame.elements[0]!.png,
            );
          }
          expect(await person.locator('[data-session-count="running"]').textContent()).toBe("12");
          stoppedEvents.clear();
          for (const [index, runId] of runIds.entries()) {
            emitAgentEvent({
              runId,
              sessionKey: keys[index]!,
              stream: "lifecycle",
              data: { phase: "end", endedAt: Date.now() },
            });
            releaseAgentRunContext(runId, claims.get(runId));
          }
          await expect.poll(() => stoppedEvents.size).toBe(12);
          await page.clock.runFor(5_000);
          await expect
            .poll(async () => {
              await page.clock.runFor(20);
              return person.getAttribute("aria-description");
            })
            .toContain("13 open sessions, 0 running");
          // A passing count must not be healed by the separate minute fallback.
          expect((await page.evaluate(() => Date.now())) - clockStartedAt).toBeLessThan(60_000);
          await page.clock.resume();
        },
      );
    } finally {
      for (const runId of runIds) {
        releaseAgentRunContext(runId, claims.get(runId));
        clearAgentRunContext(runId);
      }
      try {
        await proxy?.close();
      } finally {
        try {
          await gateway?.close({ reason: "sidebar running count proof cleanup" });
        } finally {
          await state.cleanup();
        }
      }
    }
  });
});
