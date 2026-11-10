import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ViteDevServer } from "vite";
import { expect, it } from "vitest";
import {
  assignSessionOwner,
  replaceSessionEntrySync,
} from "../../../src/config/sessions/session-accessor.ts";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import {
  setDisplayName,
  setUserProfileRole,
} from "../../../src/state/user-profile-writes.worker.ts";
import { ensureProfileForEmail } from "../../../src/state/user-profiles.ts";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { deviceGatewayEnv } from "./device-gateway-env.test-support.ts";
import { createGatewayProxy, gatewayProxyRoute } from "./gateway-proxy.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Guest owner filters with a real Gateway",
  startServerBeforeBrowser: true,
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
});

suite.define(() => {
  it("keeps guest owner filters and Person grouping within readable sessions", async () => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "guest-owner-filter",
      layout: "home",
      env: {
        ...deviceGatewayEnv,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
      },
    });
    let gateway: GatewayServer | undefined;
    let proxy: ViteDevServer | undefined;
    try {
      const viewerEmail = "owner-filter-viewer@example.test";
      const ids = [
        viewerEmail,
        "owner-filter-avery@example.test",
        "owner-filter-riley@example.test",
        "owner-filter-hidden@example.test",
        "owner-filter-sessionless@example.test",
      ].map((email, i) => {
        const profile = ensureProfileForEmail(email);
        setDisplayName(
          profile.id,
          ["Guest viewer", "Avery", "Riley", "Hidden owner", "Online only"][i]!,
        );
        return profile.id;
      });
      setUserProfileRole(ids[0]!, "guest");
      const scopes = ["operator.sessions.read", "operator.sessions.write"];
      const trustedProxy = {
        allowLoopback: true,
        allowUsers: [viewerEmail],
        deviceAutoApprove: { enabled: true, scopes },
        requiredHeaders: ["x-forwarded-proto"],
        userHeader: "x-forwarded-user",
      };
      await state.writeConfig({
        agents: {
          ownership: "explicit",
          defaults: { workspace: state.workspaceDir },
          entries: { main: {} },
        },
        gateway: {
          port,
          auth: { mode: "trusted-proxy", trustedProxy },
          trustedProxies: ["127.0.0.1", "::1"],
          controlUi: { enabled: false, allowedOrigins: [new URL(suite.server.baseUrl).origin] },
          roles: {
            default: "guest",
            definitions: { guest: { agents: ["main"], sessions: { others: "view" }, scopes } },
          },
        },
      });
      for (const [i, label] of [
        "My planning",
        "Avery shared planning",
        "Riley shared notes",
        "Hidden conversation",
        "Avery private notes",
      ].entries()) {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: "agent:main:dashboard:owner-proof-" + i },
          {
            sessionId: "owner-proof-" + i,
            label,
            updatedAt: Date.now() - i * 1000,
            visibility: i >= 3 ? "draft" : "shared",
            createdActor: { type: "human", source: "profile", id: ids[i === 4 ? 1 : i]! },
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
      const route = gatewayProxyRoute(port, viewerEmail);
      proxy = await createGatewayProxy(state.workspaceDir, {
        "/": { ...route, headers: { ...route.headers, "x-openclaw-scopes": scopes.join(",") } },
      });
      await proxy.listen();
      const gatewayUrl = new URL(proxy.resolvedUrls!.local[0]!);
      gatewayUrl.protocol = "ws:";
      await suite.withPage(
        {
          locale: "en-US",
          reducedMotion: "reduce",
          colorScheme: "dark",
          viewport: { width: 1280, height: 800 },
        },
        async ({ page }) => {
          const url = new URL("new", suite.server.baseUrl);
          url.hash = new URLSearchParams({ gatewayUrl: gatewayUrl.href }).toString();
          await page.goto(url.href);
          await page
            .locator("openclaw-gateway-url-confirmation")
            .getByRole("button", { name: "Switch to " + gatewayUrl.host, exact: true })
            .click();
          await waitForControlUiGatewayReady(page);
          expect(
            await evaluateControlUiContext(page, (app) =>
              app.gateway.snapshot.hello?.auth.scopes?.toSorted(),
            ),
          ).toEqual(scopes.toSorted());
          const sessionsView = page.locator('[data-navigation-view="sessions"]');
          if ((await sessionsView.getAttribute("aria-pressed")) !== "true") {
            await sessionsView.click();
          }
          const trigger = page.locator("#sidebar-session-owner-title");
          await trigger.waitFor();
          await expect.poll(() => trigger.textContent()).toContain("Involving me");
          await trigger.click();
          const option = (value: string) =>
            page.locator('.picker-select__option[data-value="' + value + '"]');
          await option("all").waitFor();
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            const dir = createControlUiE2eArtifactDir(
              "guest-owner-filter",
              process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR,
            );
            const frame = await takeControlUiScreenshotFrame(
              page,
              trigger,
              [option("all"), option("involving-me")],
              { animations: "disabled" },
            );
            await writeFile(path.join(dir, "owner-picker.png"), frame.png);
            console.log("Guest owner proof: " + dir);
          }
          await expect.poll(() => option("owner:" + ids[1]).textContent()).toContain("Avery");
          expect(await option("owner:" + ids[2]).textContent()).toContain("Riley");
          expect(await option("owner:" + ids[3]).count()).toBe(0);
          expect(await option("owner:" + ids[4]).count()).toBe(0);
          for (const index of [1, 2, 0]) {
            if (index !== 1) {
              await trigger.click();
            }
            await option("owner:" + ids[index]).click();
            const row = page.locator(
              '.sidebar-recent-sessions [data-session-key="agent:main:dashboard:owner-proof-' +
                index +
                '"]',
            );
            await row.waitFor();
            expect(await page.locator(".sidebar-recent-sessions [data-session-key]").count()).toBe(
              1,
            );
          }
          await trigger.click();
          await option("all").click();
          await expect
            .poll(() => page.locator(".sidebar-recent-sessions [data-session-key]").count())
            .toBe(3);
          await trigger.click();
          await option("owner:" + ids[1]).click();
          await expect.poll(() => trigger.textContent()).toContain("Avery");
          await page.reload();
          await waitForControlUiGatewayReady(page);
          await expect.poll(() => trigger.textContent()).toContain("Avery");
          await expect
            .poll(() => page.locator(".sidebar-recent-sessions [data-session-key]").count())
            .toBe(1);
          for (const method of ["users.list", "presence.query"]) {
            const denied = await evaluateControlUiContext(
              page,
              async (app, requestedMethod) => {
                try {
                  await app.gateway.snapshot.client!.request(requestedMethod, {});
                  return false;
                } catch {
                  return true;
                }
              },
              method,
            );
            expect(denied).toBe(true);
          }

          // Person grouping remains meaningful when reassignment leaves one readable owner.
          for (const i of [0, 1, 2]) {
            assignSessionOwner(
              { agentId: "main", sessionKey: "agent:main:dashboard:owner-proof-" + i },
              {
                owner: { type: "human", id: ids[1]! },
                assignedBy: { type: "human", id: ids[0]! },
              },
            );
          }
          await page.reload();
          await waitForControlUiGatewayReady(page);
          await trigger.click();
          await option("all").click();
          await expect
            .poll(() => page.locator(".sidebar-recent-sessions [data-session-key]").count())
            .toBe(3);
          expect(
            await evaluateControlUiContext(page, async (app) =>
              (
                await app.gateway.snapshot.client!.request<{ owners: Array<{ id: string }> }>(
                  "sessions.list",
                  {},
                )
              ).owners.map((owner) => owner.id),
            ),
          ).toEqual([ids[1]]);
          const available: number[] = [];
          const proofDir =
            process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
              ? createControlUiE2eArtifactDir("guest-person-grouping")
              : undefined;
          for (const viewport of [
            { width: 1280, height: 800 },
            { width: 390, height: 844 },
          ]) {
            await page.setViewportSize(viewport);
            if (viewport.width < 560) {
              await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
            }
            await page.getByRole("button", { name: /^Filter & sort/ }).click();
            await page.getByRole("button", { name: /^Group by:/ }).click();
            const person = page.getByRole("option", { name: "Person", exact: true });
            if (proofDir) {
              const frame = await takeControlUiScreenshotFrame(
                page,
                page.getByRole("option", { name: "Custom groups", exact: true }),
                [page.getByRole("option", { name: "None", exact: true })],
                { animations: "disabled" },
              );
              await writeFile(
                path.join(proofDir, "group-by-" + viewport.width + ".png"),
                frame.png,
              );
            }
            available.push(await person.count());
            await page.keyboard.press("Escape");
            await page.keyboard.press("Escape");
          }
          expect(available).toEqual([1, 1]);
          await page.setViewportSize({ width: 1280, height: 800 });
          await page.getByRole("button", { name: /^Filter & sort/ }).click();
          await page.getByRole("button", { name: /^Group by:/ }).click();
          await page.getByRole("option", { name: "Person", exact: true }).click();
          await page.reload();
          await waitForControlUiGatewayReady(page);
          await expect
            .poll(() =>
              page
                .locator(
                  '[data-session-section="person:profile:' + ids[1] + '"] [data-session-key]',
                )
                .count(),
            )
            .toBe(3);
          await page.getByRole("button", { name: /^Filter & sort/ }).click();
          await page.getByRole("button", { name: "Group by: Person", exact: true }).waitFor();
          await page.keyboard.press("Escape");
          setDisplayName(ids[2]!, "Avery");
          assignSessionOwner(
            { agentId: "main", sessionKey: "agent:main:dashboard:owner-proof-2" },
            {
              owner: { type: "human", id: ids[2]! },
              assignedBy: { type: "human", id: ids[0]! },
            },
          );
          await page.reload();
          await waitForControlUiGatewayReady(page);
          const sections = page.locator('[data-session-section^="person:"]');
          await expect.poll(() => sections.count()).toBe(2);
          for (const [index, count] of [
            [1, 2],
            [2, 1],
          ] as const) {
            const section = page.locator(
              '[data-session-section="person:profile:' + ids[index] + '"]',
            );
            expect(await section.locator("[data-session-key]").count()).toBe(count);
            expect(await section.textContent()).toContain("Avery");
          }
          const previousUrl = page.url();
          await page
            .locator(".sidebar-recent-sessions")
            .getByRole("link", { name: /Avery shared planning/ })
            .click();
          await expect.poll(() => page.url()).not.toBe(previousUrl);
          await waitForControlUiGatewayReady(page);
          await expect.poll(() => sections.count()).toBe(2);
          await trigger.click();
          await option("owner:" + ids[0]).click();
          await expect
            .poll(() => page.locator(".sidebar-recent-sessions [data-session-key]").count())
            .toBe(0);
          await page.getByRole("button", { name: /^Filter & sort/ }).click();
          await page.getByRole("button", { name: "Group by: Person", exact: true }).waitFor();
          await page.keyboard.press("Escape");
          await trigger.click();
          await option("all").click();
          await expect.poll(() => sections.count()).toBe(2);
        },
      );
    } finally {
      await runQaGatewayFixture(
        async () => proxy?.close(),
        () => gateway?.close({ reason: "guest owner proof cleanup" }),
        () => state.cleanup(),
      );
    }
  }, 120_000);
});
