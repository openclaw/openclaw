import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { getRuntimeConfig } from "../../../src/config/io.js";
import { prepareHostConfigSnapshot } from "../../../src/config/io.snapshot-preparation.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../../src/config/sessions/session-accessor.js";
import type { GatewayServer } from "../../../src/gateway/server-public.js";
import { createGatewaySession } from "../../../src/gateway/session-create-service.js";
import { resetGatewayRestartStateForInProcessRestart } from "../../../src/infra/restart.js";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.js";
import { getFreePort } from "../../../src/test-utils/ports.js";
import { createRequireRecord } from "../../../test/helpers/record.js";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const requireRecord = createRequireRecord("record", "expected-record");
const suite = createControlUiE2eSuite({
  name: "Creator Lab with a real Gateway",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("hot-applies off/on/off from the connected UI without restamping existing work", async () => {
    const state = await createOpenClawTestState({
      label: "creator-lab-browser",
      layout: "home",
      env: {
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    });
    let gateway: GatewayServer | undefined;
    const restart = vi.fn();
    const recovery = vi.fn(() => ({ status: "emitted" as const }));
    const pid = process.pid;
    process.on("SIGUSR1", restart);
    try {
      const port = await getFreePort();
      await state.writeConfig({
        plugins: { enabled: false },
        agents: { entries: { main: {} } },
        gateway: {
          port,
          auth: { mode: "none" },
          controlUi: { enabled: false, allowedOrigins: [new URL(suite.server.baseUrl).origin] },
        },
      });
      const { startGatewayServer } = await import("../../../src/gateway/server.js");
      gateway = await startGatewayServer(port, {
        auth: { mode: "none" },
        bind: "loopback",
        controlUiEnabled: false,
        prepareConfigSnapshot: prepareHostConfigSnapshot,
        hotReloadRecovery: recovery,
      });
      await gateway.startupSettled;
      const parentKey = "agent:main:creator-lab-parent";
      const parentActor = { type: "human", source: "profile", id: "creator-parent" } as const;
      const requester = { type: "human", source: "profile", id: "creator-requester" } as const;
      const isolation = {
        actor: { type: "human", source: "profile", id: "private-isolation" },
      } as const;
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: parentKey },
        {
          sessionId: "creator-lab-parent",
          updatedAt: 1,
          createdVia: "operator",
          createdActor: parentActor,
          sandbox: "required",
          sandboxProvenance: isolation,
        },
      );
      const createdKeys: string[] = [];
      const createChild = async (enabled: boolean, cfg = getRuntimeConfig()) => {
        const result = await createGatewaySession({
          cfg,
          agentId: "main",
          parentSessionKey: parentKey,
          commandSource: "creator-lab-browser",
          operatorRoleActor: { kind: "system" },
          creation: {
            via: "spawn",
            actor: { type: "agent", id: "main" },
            requesterProfileId: requester.id,
          },
        });
        expect(result.ok, JSON.stringify(result)).toBe(true);
        if (!result.ok) {
          throw new Error("creator Lab creation failed");
        }
        expect(result.entry.createdActor).toEqual(enabled ? requester : parentActor);
        expect(result.entry).not.toHaveProperty("sandboxProvenance");
        const stored = loadSessionEntry({ agentId: "main", sessionKey: result.key });
        expect(stored).toMatchObject({ sandbox: "required", sandboxProvenance: isolation });
        expect(stored?.publicShare).toBeUndefined();
        createdKeys.push(result.key);
        return { key: result.key, entry: stored };
      };
      const before = await createChild(false);
      const admittedOff = getRuntimeConfig();
      await suite.withPage(
        {
          colorScheme: "dark",
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { width: 1440, height: 1000 },
        },
        async ({ page }) => {
          let sockets = 0;
          let closes = 0;
          const patchIds = new Set<string>();
          const patchReplies: unknown[] = [];
          page.on("websocket", (socket) => {
            if (!socket.url().includes(`:${port}`)) {
              return;
            }
            sockets += 1;
            socket.on("close", () => {
              closes += 1;
            });
            socket.on("framesent", ({ payload }) => {
              const frame = requireRecord(JSON.parse(payload.toString()));
              if (frame.method === "config.patch" && typeof frame.id === "string") {
                patchIds.add(frame.id);
              }
            });
            socket.on("framereceived", ({ payload }) => {
              const frame = requireRecord(JSON.parse(payload.toString()));
              if (typeof frame.id === "string" && patchIds.has(frame.id)) {
                patchReplies.push(frame);
              }
            });
          });
          const url = new URL("settings/labs", suite.server.baseUrl);
          url.searchParams.set("gatewayUrl", `ws://127.0.0.1:${port}`);
          await page.goto(url.toString());
          const confirmation = page.locator("openclaw-gateway-url-confirmation");
          await confirmation.waitFor();
          await confirmation
            .getByRole("button", { name: `Switch to 127.0.0.1:${port}`, exact: true })
            .click();
          const toggle = page.getByRole("switch", {
            name: "Human creator attribution",
            exact: true,
          });
          await toggle.waitFor();
          await expect.poll(() => toggle.isEnabled()).toBe(true);
          expect(await toggle.isChecked()).toBe(false);
          const connectedSockets = sockets;
          const row = page.locator(".settings-row").filter({ has: toggle });
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator(".settings-page"),
            [row],
            { animations: "disabled", scrollTo: row },
          );
          await writeFile(path.join(suite.artifactDir, "after.png"), frame.png);
          await toggle.focus();
          await page.keyboard.press("Space");
          await expect
            .poll(
              () => getRuntimeConfig().agents?.defaults?.experimental?.delegatedCreatorAttribution,
            )
            .toBe(true);
          await expect.poll(() => patchReplies.length).toBe(1);
          await expect.poll(() => toggle.isEnabled()).toBe(true);
          expect(await toggle.isChecked()).toBe(true);
          const enabled = await createChild(true);
          // Already-admitted operations retain their immutable config snapshot.
          await createChild(false, admittedOff);
          await toggle.focus();
          await page.keyboard.press("Space");
          await expect
            .poll(
              () => getRuntimeConfig().agents?.defaults?.experimental?.delegatedCreatorAttribution,
            )
            .not.toBe(true);
          await expect.poll(() => patchReplies.length).toBe(2);
          await expect.poll(() => toggle.isEnabled()).toBe(true);
          expect(await toggle.isChecked()).toBe(false);
          await createChild(false);
          expect(loadSessionEntry({ agentId: "main", sessionKey: before.key })).toEqual(
            before.entry,
          );
          expect(loadSessionEntry({ agentId: "main", sessionKey: enabled.key })).toEqual(
            enabled.entry,
          );
          for (const reply of patchReplies) {
            expect(reply).toMatchObject({
              ok: true,
              payload: { sentinel: { payload: { stats: { requiresRestart: false } } } },
            });
            expect(requireRecord(requireRecord(reply).payload)).not.toHaveProperty("restart");
          }
          expect(sockets).toBe(connectedSockets);
          expect(closes).toBe(0);
          expect(process.pid).toBe(pid);
          expect(restart).not.toHaveBeenCalled();
          expect(recovery).not.toHaveBeenCalled();
          await writeFile(
            path.join(suite.artifactDir, "hot-toggle.json"),
            JSON.stringify(
              { pid, connectedSockets, sockets, closes, patchReplies, createdKeys },
              null,
              2,
            ),
          );
          // Reload only the browser: the persisted off setting remains off.
          await page.reload();
          await toggle.waitFor();
          await expect.poll(() => toggle.isEnabled()).toBe(true);
          expect(await toggle.isChecked()).toBe(false);
        },
      );
    } finally {
      await gateway?.close({ reason: "creator Lab proof complete" });
      resetGatewayRestartStateForInProcessRestart();
      process.off("SIGUSR1", restart);
      await state.cleanup();
    }
  }, 120_000);
});
