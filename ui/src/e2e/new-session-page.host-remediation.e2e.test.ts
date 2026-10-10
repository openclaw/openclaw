import path from "node:path";
import { expect, it } from "vitest";
import { resolveRequiredNodeCommandAuthority } from "../../../src/gateway/node-command-policy.js";
import {
  captureUiProofEnabled,
  createNewSessionPageE2eSuite,
  installMockGateway,
  openEnvironmentPicker,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it("explains paired-host and missing-harness remediation without changing the selected runtime", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const command = "codex.exec-server.stdio.v1";
    const requiredNodeCommand = resolveRequiredNodeCommandAuthority({
      nodeId: "missing-harness",
      requiredCommands: [command],
      declaredCommands: [],
      effectiveCommands: [],
      withheldCommands: [],
      allowlist: new Set([command]),
    });
    const gateway = await installMockGateway(page, {
      agentModel: "openai/gpt-5.5",
      models: [
        {
          available: true,
          id: "gpt-5.5",
          name: "GPT 5.5",
          provider: "openai",
          agentRuntime: {
            id: "codex",
            cloudPlacementSupported: true,
            devicePlacementSupported: true,
            devicePlacement: { requiredNodeCommands: [command], consumesWorkerSlot: false },
            source: "model",
          },
        },
      ],
      methodResponses: {
        "environments.list": {
          profiles: [],
          environments: [
            {
              id: "node:paired-device",
              type: "node",
              label: "Paired device",
              status: "available",
              sessionHost: false,
            },
            {
              id: "node:missing-harness",
              type: "node",
              label: "Session host",
              status: "available",
              sessionHost: true,
              requiredNodeCommand,
            },
          ],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      await openEnvironmentPicker(page);
      const where = page.locator("wa-popover.new-session-page__where-popover");
      const hints: string[] = [];
      for (const id of ["paired-device", "missing-harness"]) {
        const row = where.locator(`[data-value="device:${id}"]`);
        await row.hover();
        const details = row
          .locator("xpath=ancestor::openclaw-tooltip[1]")
          .locator('[slot="content"]');
        await details.waitFor({ state: "visible" });
        hints.push((await details.textContent()) ?? "");
        if (captureUiProofEnabled) {
          await page.screenshot({
            animations: "disabled",
            path: path.join(suite.artifactDir, `${id}.png`),
          });
        }
      }

      expect(hints[0]).toContain("openclaw config set nodeHost.workerRuns.enabled true");
      expect(hints[0]).toContain("openclaw node install --force");
      expect(hints[0]).not.toContain("openclaw connect");
      expect(hints[1]).toContain(
        "This model runs on the Codex harness, which isn't installed on this device. Choose a model that uses the OpenClaw harness, or install Codex on the device.",
      );
      expect(hints[1]).toContain("openclaw plugins install @openclaw/codex");
      expect(hints[1]).toContain("openclaw plugins enable codex");
      expect(hints[1]).toContain("openclaw node restart");
      expect(hints[1]).toContain("openclaw nodes pending");
      expect(hints[1]).toContain("openclaw nodes approve <requestId>");
      const install = where.getByText("Install Codex on this device", { exact: true });
      await install.click();
      await where.getByText("openclaw plugins install @openclaw/codex", { exact: true }).waitFor({
        state: "visible",
      });
      if (captureUiProofEnabled) {
        await page.screenshot({
          animations: "disabled",
          path: path.join(suite.artifactDir, "install-codex.png"),
        });
      }
      expect((await gateway.getRequests("environments.list")).at(-1)?.params).toEqual({
        runtimeId: "codex",
      });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
});
