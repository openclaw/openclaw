import { expect, it } from "vitest";
import type { GatewayAgentRow } from "../api/types.ts";
import {
  captureUiProof,
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  installMockGateway,
  waitForCommittedChatRoute,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it.each([false, true])(
    "creates a configured-default worker session and sends a follow-up (required policy: %s)",
    async (required) => {
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
          featureMethods: [
            "agent.wait",
            "chat.metadata",
            "chat.startup",
            "chat.send",
            "environments.list",
            "sessions.create",
            "sessions.send",
            "sessions.describe",
            "sessions.reclaim",
            ...(required ? [] : ["sessions.dispatch"]),
          ],
          operatorScopes: required
            ? ["operator.read", "operator.write"]
            : ["operator.admin", "operator.read", "operator.write"],
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
          deferredMethods: [required ? "sessions.describe" : "sessions.dispatch"],
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
              ...(required ? { requiredProfile: "studio-device" } : {}),
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
            "sessions.describe": { session: { key: sessionKey, placement } },
            "sessions.dispatch": { placement },
            "sessions.send": { runId: "worker-initial", status: "started" },
          },
        });
        await page.goto(suite.server.baseUrl + "new");
        await gateway.waitForRequest("environments.list");
        if (required) {
          await page.getByText("OpenClaw worker", { exact: true }).waitFor();
          expect(await page.locator("#new-session-where-trigger").count()).toBe(0);
          expect(await page.locator("#new-session-project-trigger").count()).toBe(0);
        } else {
          await page.locator("#new-session-where-trigger").click();
          await page.locator('[data-value="cloud:studio-device"]').click();
          await expect
            .poll(() =>
              page.locator("#new-session-where-trigger").getAttribute("data-cloud-profile"),
            )
            .toBe("studio-device");
          await page.keyboard.press("Escape");
        }
        await page.locator(".new-session-page__message").fill("Inspect the worker workspace");
        const start = page.getByRole("button", { name: "Start session", exact: true });
        await expect
          .poll(async () => ({
            enabled: await start.isEnabled(),
            reason: await start.getAttribute("title"),
          }))
          .toMatchObject({ enabled: true });
        // Policy-off is the comparison baseline, not a capture from an older binary.
        // The suite owns a fresh per-test artifact directory; withPage exposes no artifact owner.
        await captureUiProof(
          suite,
          page,
          required
            ? "after-required-readonly-before-submit.png"
            : "before-policy-off-selected-profile.png",
        );
        await start.click();
        const create = await gateway.waitForRequest("sessions.create");
        expect(create.params).toMatchObject({
          agentId: "main",
          message: "",
          worktree: true,
          worktreeSource: "empty",
        });
        expect(create.params).not.toHaveProperty("model");
        expect(create.params).not.toHaveProperty("agentRuntime");
        if (required) {
          await gateway.waitForRequest("sessions.describe");
          expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
        } else {
          const dispatch = await gateway.waitForRequest("sessions.dispatch");
          expect(dispatch.params).toEqual({
            key: sessionKey,
            agentId: "main",
            profileId: "studio-device",
          });
        }
        expect(await gateway.getRequests("sessions.send")).toHaveLength(0);
        await gateway.resolveDeferred(required ? "sessions.describe" : "sessions.dispatch");
        expect((await gateway.waitForRequest("sessions.send")).params).toMatchObject({
          key: sessionKey,
          message: "Inspect the worker workspace",
        });
        await page.waitForURL((url) => url.pathname === controlUiSessionPath(sessionKey));
        // The URL can publish while the Chat module is still loading. Deliver
        // the synthetic terminal event only after its route and startup consumer exist.
        await waitForCommittedChatRoute(page);
        await gateway.waitForRequest("chat.startup");
        await page.locator(".chat-thread-inner").waitFor();
        await gateway.emitChatFinal({
          runId: "worker-initial",
          text: "Worker workspace inspected.",
          sessionKey,
        });
        await page
          .locator(".chat-thread-inner")
          .getByText("Worker workspace inspected.", { exact: true })
          .waitFor();
        await page
          .locator(".agent-chat__composer-combobox textarea")
          .fill("Now check the examples");
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
              ["sessions.create", "sessions.dispatch", "sessions.send", "chat.send"].includes(
                method,
              ),
            )
            .map(({ method }) => method),
        ).toEqual(
          required
            ? ["sessions.create", "sessions.send", "chat.send"]
            : ["sessions.create", "sessions.dispatch", "sessions.send", "chat.send"],
        );
      });
    },
  );
});
