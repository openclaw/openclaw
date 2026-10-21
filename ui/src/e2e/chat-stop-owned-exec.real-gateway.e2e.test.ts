import fs from "node:fs/promises";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import type { SessionsProcessesListResult } from "../../../packages/gateway-protocol/src/schema/session-processes.js";
import type { OpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import {
  backgroundWorkFixture as fixture,
  createBackgroundWorkInstance,
  observeBackgroundWorkRpc,
  startBackgroundWorkProvider,
} from "./background-work.real-gateway.test-support.ts";
import {
  assertFixtureSecretsAbsent,
  assertServedUi,
  chatControls,
  pairFixture,
} from "./chat-lifecycle.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { captureFrame, seedStorage } from "./sidebar-assertions.test-support.ts";

for (const stopMethod of ["button", "slash"] as const) {
  // This boundary covers composer Stop reaching real yielded exec and existing child-model cancellation.
  // The independent process-panel fixture owns deliberate background service behavior.
  let instance: OpenClawTestInstance;
  let provider: Awaited<ReturnType<typeof startBackgroundWorkProvider>>;
  let artifactDir: string;
  const viewport = { width: 1440, height: 1000 };
  const suite = createControlUiE2eSuite({
    name: `Composer ${stopMethod} Stop owns ordinary yielded execution through a real Gateway`,
    startServerBeforeBrowser: true,
    async startServer() {
      artifactDir = createControlUiE2eArtifactDir(`chat-stop-owned-exec-${stopMethod}`);
      await fs.access("dist/control-ui/index.html");
      provider = await startBackgroundWorkProvider({ ordinaryExec: true });
      const cleanup = () =>
        runQaGatewayFixture(
          () => instance?.cleanup(),
          () => provider.stop(),
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

  async function verifyStop(signal: AbortSignal) {
    const context = await suite.newBrowserContext({
      ...createControlUiE2eContextOptions(),
      viewport,
      colorScheme: "dark",
      recordVideo: { dir: artifactDir, size: viewport },
    });
    const page = await context.newPage();
    await seedStorage(page, {
      "openclaw:control-ui:community-invite:v2": JSON.stringify({
        dismissedAtMs: 1770000000000,
      }),
    });
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
      await pairFixture(page, instance);
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, fixture.key));
      await waitForControlUiGatewayReady(page);
      const { pane, composer, send, stop } = chatControls(page);
      const capture = async (name: string, content: Locator[]) => {
        await assertFixtureSecretsAbsent(page, instance, "synthetic-background-fixture-key");
        await captureFrame(artifactDir, name + ".png", pane, content);
      };
      await composer.waitFor();
      await assertServedUi(page, suite.server.baseUrl);
      await composer.fill("Start an ordinary command and a helper, then wait for my instruction.");
      await send.click();
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
      await capture("request-running", [stop, output]);

      const beforeStop = wire.completed.length;
      if (stopMethod === "button") {
        await stop.hover();
        await stop.click();
      } else {
        await composer.fill("/stop");
        await composer.press("Enter");
      }
      const stopped = await wire.waitFor(
        (rpc) => rpc.request.method === (stopMethod === "slash" ? "sessions.abort" : "chat.abort"),
        beforeStop,
      );
      expect(stopped).toMatchObject({
        request: {
          params:
            stopMethod === "slash"
              ? { key: fixture.key, clearQueued: true }
              : { sessionKey: fixture.key, runId: expect.any(String) },
        },
        response: {
          ok: true,
          payload: stopMethod === "slash" ? { status: "aborted" } : { ok: true, aborted: true },
        },
      });
      await provider.wait(provider.parentClosed, signal);
      await provider.wait(provider.childClosed, signal);
      await stop.waitFor({ state: "hidden" });
      expect(provider.processIsOpen(), "Stop must join physical command cleanup").toBe(false);
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
      await capture("request-stopped", [composer, output]);

      expect(provider.parentRequests()).toBe(3);
      await composer.fill(fixture.nextPrompt);
      await send.click();
      // The reply proves the new run started; Stop may still be hidden during send admission.
      await pane.filter({ hasText: fixture.nextReply }).waitFor();
      await stop.waitFor({ state: "hidden" });
      // Live and persisted reply copies can overlap until the run settles.
      await pane.getByRole("paragraph").filter({ hasText: fixture.nextReply }).waitFor();
      expect(
        provider.parentRequests(),
        "only the new human prompt may start another model turn",
      ).toBe(4);
      expect(wire.completed.filter((rpc) => rpc.request.method === "chat.send")).toHaveLength(2);
      await capture("new-instruction-completed", [composer, output]);
    } finally {
      await suite.closeBrowserContext(context);
    }
  }

  suite.define(() => {
    it(
      "stops yielded exec and its child without reviving the request or blocking a new instruction",
      (test) =>
        suite.runScenario(test, {
          retainedState: () => instance.stateDir,
          run: verifyStop,
        }),
      60000,
    );
  });
}
