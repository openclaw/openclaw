import { expect, it } from "vitest";
import type { GatewayAgentRow } from "../api/types.ts";
import {
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it("creates a configured-default worker session and sends a follow-up without Gateway provider credentials", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const sessionKey = "agent:main:worker-inference";
      const runtime = {
        id: "openclaw",
        source: "model",
        cloudPlacementSupported: true,
        cloudPlacementExecutionMode: "worker-turn",
        devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
      } satisfies NonNullable<GatewayAgentRow["agentRuntime"]>;
      const placement = {
        state: "active",
        generation: 1,
        createdAtMs: 1,
        updatedAtMs: 1,
        stateChangedAtMs: 1,
        providerId: "device",
        profileId: "studio-device",
        environmentId: "worker:studio-device",
        activeOwnerEpoch: 1,
        workerBundleHash: "a".repeat(64),
        workspaceBaseManifestRef: "base-manifest",
        remoteWorkspaceDir: "/worker/workspace",
        inference: "worker",
      };
      const gateway = await installMockGateway(page, {
        agentModel: "openai/gpt-4.1-mini",
        operatorScopes: ["operator.admin", "operator.read", "operator.write"],
        models: [
          {
            id: "gpt-4.1-mini",
            name: "GPT-4.1 mini",
            provider: "openai",
            available: false,
            unavailableReason: "missing-auth",
            agentRuntime: runtime,
          },
        ],
        workspace: "/workspace",
        workspaceGit: true,
        historyMessages: [],
        deferredMethods: ["sessions.dispatch"],
        methodResponses: {
          "agents.list": {
            agents: [
              {
                id: "main",
                name: "Assistant",
                model: { primary: "openai/gpt-4.1-mini" },
                agentRuntime: runtime,
                workspace: "/workspace",
                workspaceGit: true,
              },
            ],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          },
          "environments.list": {
            environments: [],
            profiles: [
              {
                id: "studio-device",
                providerId: "device",
                executionModes: ["worker-turn"],
                inference: "worker",
              },
            ],
          },
          "worktrees.branches": {
            repositoryStatus: "git",
            branches: [{ name: "main", kind: "local" }],
            defaultBranch: "main",
          },
          "sessions.create": { key: sessionKey },
          "sessions.list": {
            count: 1,
            ts: 1,
            path: "",
            defaults: { model: "gpt-4.1-mini", modelProvider: "openai", contextTokens: 128000 },
            sessions: [
              {
                key: sessionKey,
                kind: "direct",
                updatedAt: 1,
                displayName: "Worker inference",
                model: "gpt-4.1-mini",
                modelProvider: "openai",
                agentRuntime: runtime,
                placement,
              },
            ],
          },
          "sessions.dispatch": { placement },
          "sessions.send": { runId: "worker-initial", status: "started" },
        },
      });
      await page.goto(suite.server.baseUrl + "new");
      await gateway.waitForRequest("environments.list");
      await page.locator("#new-session-where-trigger").click();
      await page.locator('[data-value="cloud:studio-device"]').click();
      await expect
        .poll(() => page.locator("#new-session-where-trigger").getAttribute("data-cloud-profile"))
        .toBe("studio-device");
      await page.keyboard.press("Escape");
      await page.locator(".new-session-page__message").fill("Inspect the worker workspace");
      await page.getByRole("button", { name: "Start session", exact: true }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "main",
        message: "",
        worktree: true,
        worktreeSource: "empty",
      });
      expect(create.params).not.toHaveProperty("model");
      expect(create.params).not.toHaveProperty("agentRuntime");
      const dispatch = await gateway.waitForRequest("sessions.dispatch");
      expect(dispatch.params).toEqual({
        key: sessionKey,
        agentId: "main",
        profileId: "studio-device",
      });
      expect(await gateway.getRequests("sessions.send")).toHaveLength(0);
      await gateway.resolveDeferred("sessions.dispatch");
      expect((await gateway.waitForRequest("sessions.send")).params).toMatchObject({
        key: sessionKey,
        message: "Inspect the worker workspace",
      });
      await page.waitForURL((url) => url.pathname === controlUiSessionPath(sessionKey));
      await gateway.emitChatFinal({
        runId: "worker-initial",
        text: "Worker workspace inspected.",
        sessionKey,
      });
      await page
        .locator(".chat-thread-inner")
        .getByText("Worker workspace inspected.", { exact: true })
        .waitFor();
      await page.locator(".agent-chat__composer-combobox textarea").fill("Now check the examples");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      const followUp = await gateway.waitForRequest("chat.send");
      expect(followUp.params).toMatchObject({
        sessionKey,
        message: "Now check the examples",
        deliver: false,
      });
      expect(
        (await gateway.getRequests())
          .filter(({ method }) =>
            ["sessions.create", "sessions.dispatch", "sessions.send", "chat.send"].includes(method),
          )
          .map(({ method }) => method),
      ).toEqual(["sessions.create", "sessions.dispatch", "sessions.send", "chat.send"]);
    });
  });
});
