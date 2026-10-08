import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { SessionsProcessesListResult } from "../../../packages/gateway-protocol/src/schema/session-processes.js";
import type { OpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { pairControlUiPage } from "../test-helpers/control-ui-browser-pairing.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { enterControlUiSession } from "../test-helpers/control-ui-session-entry.ts";
import {
  backgroundWorkFixture as fixture,
  createBackgroundWorkInstance,
  observeBackgroundWorkRpc,
  startBackgroundWorkProvider,
} from "./background-work.real-gateway.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

for (const stopMethod of ["button", "slash"] as const) {
  // This boundary covers composer Stop reaching real yielded exec and existing child-model cancellation.
  // The independent process-panel fixture owns deliberate background service behavior.
  let instance: OpenClawTestInstance;
  let provider: Awaited<ReturnType<typeof startBackgroundWorkProvider>>;
  let artifactDir: string;
  const viewport = { width: 1440, height: 1000 };
  const proof: Record<string, unknown> = {
    provider: "synthetic loopback Responses provider",
    gateway: "isolated real Gateway serving this checkout's built Control UI",
    viewport,
    stopMethod,
    complete: false,
  };
  const saveProof = () =>
    fs.writeFile(path.join(artifactDir, "proof.json"), JSON.stringify(proof, null, 2) + "\n");

  const suite = createControlUiE2eSuite({
    name: `Composer ${stopMethod} Stop owns ordinary yielded execution through a real Gateway`,
    startServerBeforeBrowser: true,
    async startServer() {
      artifactDir = createControlUiE2eArtifactDir(`chat-stop-owned-exec-${stopMethod}`);
      await fs.access("dist/control-ui/index.html");
      provider = await startBackgroundWorkProvider({ ordinaryExec: true });
      const cleanup = () =>
        runQaGatewayFixture(
          async () => {
            await instance?.cleanup();
            proof.gatewayStopped = !instance?.child;
          },
          async () => {
            await provider.stop();
            proof.providerStopped = true;
          },
          saveProof,
        );
      try {
        instance = await createBackgroundWorkInstance(provider.port, true);
        await instance.startGateway();
        return { baseUrl: `http://127.0.0.1:${instance.port}/`, close: cleanup };
      } catch (error) {
        return runQaGatewayFixture(async () => {
          throw error;
        }, cleanup);
      }
    },
  });

  async function runCli(args: string[]) {
    const result = await instance.cli(args);
    expect(result.code, result.stderr).toBe(0);
    return result.stdout;
  }

  async function capture(page: Page, name: string, surface: Locator, content: Locator[]) {
    const text = (await page.locator("body").textContent()) ?? "";
    for (const secret of [
      instance.gatewayToken,
      instance.hookToken,
      instance.stateDir,
      instance.homeDir,
      "synthetic-background-fixture-key",
    ]) {
      expect(text.includes(secret), "proof must contain synthetic public content only").toBe(false);
    }
    expect(new URL(page.url()).hash).toBe("");
    const frame = await takeControlUiScreenshotFrame(page, surface, content, {
      animations: "disabled",
    });
    await fs.writeFile(path.join(artifactDir, name + ".png"), frame.png);
    await saveProof();
  }

  suite.define(() => {
    it("stops yielded exec and its child without reviving the request or blocking a new instruction", async (test) => {
      await suite.runScenario(test, {
        retainedState: () => instance.stateDir,
        run: async (signal) => {
          const context = await suite.newBrowserContext({
            ...createControlUiE2eContextOptions(),
            viewport,
            colorScheme: "dark",
            recordVideo: { dir: artifactDir, size: viewport },
          });
          await context.addInitScript(() => {
            localStorage.setItem(
              "openclaw:control-ui:community-invite:v2",
              JSON.stringify({ dismissedAtMs: 1770000000000 }),
            );
          });
          const page = await context.newPage();
          const video = page.video();
          const wire = observeBackgroundWorkRpc(page, signal);
          try {
            await runCli([
              "gateway",
              "call",
              "sessions.create",
              "--json",
              "--params",
              JSON.stringify({ key: fixture.key, agentId: "main", label: "Stop request proof" }),
            ]);
            await pairControlUiPage(page, runCli);
            await page.goto(controlUiSessionUrl(suite.server.baseUrl, fixture.key));
            await enterControlUiSession(page);
            await waitForControlUiGatewayReady(page);
            const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
            const composer = pane.getByRole("textbox", { name: "Chat composer", exact: true });
            await composer.waitFor();
            const script = await page
              .locator('script[type="module"][src]')
              .first()
              .getAttribute("src");
            expect(script).toMatch(/^\/assets\/.+\.js$/);
            const asset = await context.request.get(new URL(script!, suite.server.baseUrl).href);
            expect(asset.ok()).toBe(true);
            const served = await asset.body();
            const built = await fs.readFile(path.join("dist/control-ui", script!.slice(1)));
            expect(served.equals(built), "served UI must be this checkout's built bundle").toBe(
              true,
            );
            proof.uiAsset = {
              path: script,
              sha256: createHash("sha256").update(served).digest("hex"),
            };

            proof.stage = "ordinary exec yields while the request remains active";
            await composer.fill(
              "Start an ordinary command and a helper, then wait for my instruction.",
            );
            await pane.getByRole("button", { name: "Send message", exact: true }).click();
            const sent = await wire.waitFor((rpc) => rpc.request.method === "chat.send");
            expect(sent.response.ok).toBe(true);
            for (const gate of [
              provider.processConnected,
              provider.childStarted,
              provider.parentPending,
            ]) {
              await provider.wait(gate, signal);
            }
            await openChatSidePanelType(page, "Processes");
            const processes = pane.locator("openclaw-chat-processes-panel");
            const listed = await wire.waitFor(
              (rpc) =>
                rpc.request.method === "sessions.processes.list" &&
                (rpc.response.payload as SessionsProcessesListResult | undefined)?.processes?.some(
                  (row) => row.tail.includes(fixture.output),
                ) === true,
            );
            expect(listed.response.ok).toBe(true);
            const list = listed.response.payload as SessionsProcessesListResult;
            expect(list.processes).toHaveLength(1);
            const process = list.processes[0]!;
            expect(process.status).toBe("running");
            await processes.getByRole("button", { name: process.name, exact: true }).click();
            const output = processes.locator("pre");
            await output.waitFor();
            expect(await output.textContent()).toContain(fixture.output);
            const stop = pane.getByRole("button", { name: "Stop generating", exact: true });
            await capture(page, "request-running", pane, [stop, output]);

            proof.stage = "composer Stop cancels the request";
            const beforeStop = wire.completed.length;
            if (stopMethod === "button") {
              await stop.hover();
              await stop.click();
            } else {
              await composer.fill("/stop");
              await composer.press("Enter");
            }
            const stopped = await wire.waitFor(
              (rpc) => rpc.request.method === "chat.abort",
              beforeStop,
            );
            expect(stopped.response.ok).toBe(true);
            expect(stopped.request.params).toMatchObject({ sessionKey: fixture.key });
            expect(stopped.response.payload).toMatchObject({ ok: true, aborted: true });
            await provider.wait(provider.parentClosed, signal);
            await provider.wait(provider.childClosed, signal);
            await stop.waitFor({ state: "hidden" });
            proof.childClosed = true;
            proof.processOpenAfterStopReply = provider.processIsOpen();
            // Preserve the genuine baseline before the expected failure waits for process cleanup.
            // The suite closes the recording even when this pre-fix wait reaches the test deadline.
            await capture(page, "stop-replied", pane, [composer, output]);
            proof.stage = "wait for physical process cleanup";
            await saveProof();
            expect(proof.processOpenAfterStopReply, "Stop must join physical command cleanup").toBe(
              false,
            );
            await provider.wait(provider.processClosed, signal);
            expect(provider.processIsOpen()).toBe(false);
            provider.releaseProcess();
            const terminal = await wire.waitFor(
              (rpc) =>
                rpc.request.method === "sessions.processes.list" &&
                (rpc.response.payload as SessionsProcessesListResult | undefined)?.processes?.some(
                  (row) => row.instanceId === process.instanceId && row.status === "killed",
                ) === true,
              beforeStop,
            );
            expect(terminal.response.ok).toBe(true);
            await processes.getByText("Stopped", { exact: true }).waitFor();
            expect(await output.textContent()).toContain(fixture.output);
            proof.processSocketClosed = true;
            await capture(page, "request-stopped", pane, [composer, output]);

            proof.stage = "new human instruction still completes";
            expect(provider.parentRequests()).toBe(3);
            await composer.fill(fixture.nextPrompt);
            await pane.getByRole("button", { name: "Send message", exact: true }).click();
            await pane.getByRole("paragraph").filter({ hasText: fixture.nextReply }).waitFor();
            await stop.waitFor({ state: "hidden" });
            expect(
              provider.parentRequests(),
              "only the new human prompt may start another model turn",
            ).toBe(4);
            expect(wire.completed.filter((rpc) => rpc.request.method === "chat.send")).toHaveLength(
              2,
            );
            proof.parentModelRequests = provider.parentRequests();
            proof.newInstructionCompleted = true;
            proof.stage = "complete";
            proof.complete = true;
            await capture(page, "new-instruction-completed", pane, [composer, output]);
          } finally {
            await suite.closeBrowserContext(context);
            if (video) {
              proof.recording = path.basename(await video.path());
            }
            await saveProof();
          }
        },
      });
    }, 60_000);
  });
}
