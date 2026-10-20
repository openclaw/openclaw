import { expect, it } from "vitest";
import type { GatewayAgentRow } from "../api/types.ts";
import {
  captureUiProof,
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  installMockGateway,
  LOCAL_GIT_WORKSPACE_RESPONSES,
  waitForCommittedChatRoute,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it.each([false, true])(
    "creates a configured-default worker session and sends a follow-up (required policy: %s)",
    (required) =>
      suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
        const sessionKey = "agent:main:worker-inference";
        const runtime = {
          id: "openclaw",
          source: "model",
          cloudPlacementSupported: true,
          cloudPlacementExecutionMode: "worker-turn",
          devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
        } satisfies NonNullable<GatewayAgentRow["agentRuntime"]>;
        const profile = {
          id: "studio-device",
          providerId: "device",
          executionModes: ["worker-turn"],
          inference: "worker",
        };
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
            ...LOCAL_GIT_WORKSPACE_RESPONSES,
            "agents.list": {
              ...LOCAL_GIT_WORKSPACE_RESPONSES["agents.list"],
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
              sessionPlacement: required ? { requiredProfile: profile } : {},
            },
            "environments.list": {
              ...(required ? { requiredProfile: "studio-device" } : {}),
              environments: [],
              profiles: [profile],
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
        const where = page.locator("#new-session-where-trigger");
        const transcript = page.locator(".chat-thread-inner");
        await page.goto(suite.server.baseUrl + "new");
        if (required) {
          await page.getByText("OpenClaw worker", { exact: true }).waitFor();
          expect(await where.count()).toBe(0);
          expect(await page.locator("#new-session-project-trigger").count()).toBe(0);
        } else {
          await gateway.waitForRequest("environments.list");
          await where.click();
          await page.locator('[data-value="cloud:studio-device"]').click();
          await expect.poll(() => where.getAttribute("data-cloud-profile")).toBe("studio-device");
          await page.keyboard.press("Escape");
        }
        await page.locator(".new-session-page__message").fill("Inspect the worker workspace");
        const start = page.getByRole("button", { name: "Start session", exact: true });
        await expect.poll(() => start.isEnabled()).toBe(true);
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
        await transcript.waitFor();
        await gateway.emitChatFinal({
          runId: "worker-initial",
          text: "Worker workspace inspected.",
          sessionKey,
        });
        await transcript.getByText("Worker workspace inspected.", { exact: true }).waitFor();
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
        const methods = (await gateway.getRequests()).map(({ method }) => method);
        expect(
          methods.filter((method) =>
            ["sessions.create", "sessions.dispatch", "sessions.send", "chat.send"].includes(method),
          ),
        ).toEqual([
          "sessions.create",
          ...(required ? [] : ["sessions.dispatch"]),
          "sessions.send",
          "chat.send",
        ]);
      }),
  );
});
