import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI goal recovery" });

suite.define(() => {
  it("lets an invalid Goal edit be corrected without reload or recovery", async () => {
    const artifacts = createControlUiE2eArtifactDir("goal-invalid-edit");
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, colorScheme: "light" },
      async ({ page }) => {
        const now = Date.now();
        const goal = {
          schemaVersion: 1,
          id: "goal-edit",
          objective: "Verify the sample deployment",
          status: "paused",
          createdAt: now,
          updatedAt: now,
          tokenStart: 0,
          tokensUsed: 0,
          continuationTurns: 0,
        };
        const method = "sessions.goal.update";
        const gateway = await installMockGateway(page, {
          sessionKey: "agent:main:main",
          heldMethods: [method],
          methodResponses: {
            "sessions.list": {
              ts: now,
              path: "",
              count: 1,
              defaults: { model: "test-model", modelProvider: "test", contextTokens: 128_000 },
              sessions: [
                {
                  key: "agent:main:main",
                  sessionId: "goal-edit-session",
                  kind: "direct",
                  updatedAt: now,
                  goal,
                },
              ],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}chat/main`);
        await page.getByRole("button", { name: "Edit goal", exact: true }).click();
        const objective = page.locator(".agent-chat__composer-combobox textarea");
        const save = page.getByRole("button", { name: "Save goal", exact: true });
        const invalid = page.getByText(
          "Goal update is invalid. Check the objective and try again.",
          { exact: true },
        );
        await objective.fill("x".repeat(16_001));
        await save.click();
        await expect
          .poll(
            async () =>
              (await gateway.getRequests(method)).length > 0 || (await invalid.isVisible()),
          )
          .toBe(true);
        // Model the Gateway's ordinary schema refusal if invalid input escapes the UI.
        if ((await gateway.getRequests(method)).length > 0) {
          await gateway.rejectDeferred(method, {
            code: "INVALID_REQUEST",
            message: "Invalid goal edit",
          });
          await expect.poll(() => save.isEnabled()).toBe(true);
        }
        await page.screenshot({ path: path.join(artifacts, "invalid-edit.png") });
        expect(await invalid.isVisible()).toBe(true);
        expect(await gateway.getRequests(method)).toHaveLength(0);
        expect(await page.getByRole("button", { name: "Check outcome", exact: true }).count()).toBe(
          0,
        );

        const corrected = "Verify only the sample deployment";
        await objective.fill(corrected);
        await save.click();
        const request = await gateway.waitForRequest(method);
        expect(request.params).toMatchObject({ action: "edit", objective: corrected });
        await gateway.resolveDeferred(method, {
          status: "updated",
          goalId: goal.id,
          goal: { ...goal, objective: corrected, updatedAt: now + 1 },
        });
        await expect.poll(() => save.count()).toBe(0);
        await expect
          .poll(() => page.locator(".agent-chat__goal-objective").textContent())
          .toBe(corrected);
        expect(await gateway.getRequests(method)).toHaveLength(1);
        expect(await invalid.count()).toBe(0);
        await page.screenshot({ path: path.join(artifacts, "corrected-edit.png") });
      },
    );
  });

  it.each([
    { action: "pause", legacyScope: false },
    { action: "clear", legacyScope: false },
    { action: "resume", legacyScope: false },
    { action: "resume", legacyScope: true },
  ] as const)(
    "bounds $action recovery by its authenticated scope (empty scope=$legacyScope)",
    async ({ action, legacyScope }) => {
      const artifacts = createControlUiE2eArtifactDir(`goal-recovery-${action}`);
      await suite.withPage(
        { viewport: { width: 1440, height: 900 }, colorScheme: "light" },
        async ({ page }) => {
          if (legacyScope) {
            await page.addInitScript(() => {
              Object.defineProperty(window.crypto, "subtle", { value: undefined });
            });
          }
          const now = Date.now();
          const goal = {
            schemaVersion: 1,
            id: "goal-recovery",
            objective: "Verify the sample deployment",
            status: action === "pause" ? "active" : "paused",
            createdAt: now - 60_000,
            updatedAt: now,
            pausedAt: now,
            tokenStart: 0,
            tokensUsed: 100,
            continuationTurns: 0,
          };
          const sessions = {
            ts: now,
            path: "",
            count: 1,
            defaults: { model: "test-model", modelProvider: "test", contextTokens: 128_000 },
            sessions: [
              {
                key: "agent:main:main",
                sessionId: "goal-recovery-session",
                kind: "direct",
                displayName: "Deployment checks",
                updatedAt: now,
                goal,
              },
            ],
          };
          const method = action === "clear" ? "sessions.goal.clear" : "sessions.goal.update";
          const gateway = await installMockGateway(page, {
            sessionKey: "agent:main:main",
            heldMethods: [method],
            omitConnectHelloAuth: legacyScope,
            historyMessages: [
              {
                role: "assistant",
                content: [{ type: "text", text: "Deployment checks are ready." }],
              },
            ],
            methodResponses: { "sessions.list": sessions },
          });
          await page.goto(`${suite.server.baseUrl}chat/main`);
          const original = page.getByRole("button", {
            name: `${action.charAt(0).toUpperCase()}${action.slice(1)} goal`,
            exact: true,
          });
          await original.waitFor();
          await page.clock.install();
          await original.click();
          if (legacyScope) {
            await page
              .getByText(
                "Goal update was not sent because its recovery request could not be saved.",
              )
              .waitFor();
            expect(await gateway.getRequests(method)).toHaveLength(0);
            expect(
              await page.evaluate(() =>
                Object.keys(sessionStorage).filter((key) =>
                  key.startsWith("openclaw.control.goalOperation.v1:"),
                ),
              ),
            ).toHaveLength(0);
            await page.reload();
            await original.waitFor();
            expect(
              await page.getByRole("button", { name: "Check outcome", exact: true }).count(),
            ).toBe(0);
            expect(await gateway.getRequests(method)).toHaveLength(0);
            return;
          }
          const first = await gateway.waitForRequest(method);
          if (!isRecord(first.params)) {
            throw new Error("Missing goal operation parameters");
          }
          // Commit and publish the authoritative state while withholding only this RPC's ACK.
          const committed =
            action === "clear"
              ? undefined
              : {
                  ...goal,
                  status: action === "pause" ? "paused" : "active",
                  updatedAt: now + 1_000,
                };
          await gateway.setSessionsListResponse({
            ...sessions,
            sessions: [{ ...sessions.sessions[0], goal: committed }],
          });
          await gateway.emitGatewayEvent("sessions.changed", {
            sessionKey: "agent:main:main",
            reason: "goal",
          });
          const sockets = await gateway.getSocketCount();
          for (let tick = 0; tick < 6; tick += 1) {
            await gateway.emitGatewayEvent("tick", { ts: Date.now() });
            await page.clock.fastForward(5_001);
          }
          if (committed) {
            await page.locator(`.agent-chat__goal--${committed.status}`).waitFor();
          } else {
            await expect.poll(() => page.locator(".agent-chat__goal").count()).toBe(0);
          }
          await page.screenshot({ path: path.join(artifacts, "lost-ack.png") });
          const checkOutcome = page.getByRole("button", { name: "Check outcome", exact: true });
          await expect.poll(() => checkOutcome.isEnabled()).toBe(true);
          expect(await gateway.getSocketCount()).toBe(sockets);
          expect(await gateway.getRequests(method)).toHaveLength(1);
          await page.reload();
          await checkOutcome.waitFor();
          expect(await gateway.getRequests(method)).toHaveLength(0);
          expect(await original.count()).toBe(0);
          if (committed) {
            await page.locator(`.agent-chat__goal--${committed.status}`).waitFor();
          } else {
            expect(await page.locator(".agent-chat__goal").count()).toBe(0);
          }
          await checkOutcome.click();
          const retried = await gateway.waitForRequest(method);
          expect(retried.params).toEqual(first.params);
          await gateway.resolveDeferred(method, {
            operationId: first.params.operationId,
            action,
            status: action === "resume" ? "started" : action === "clear" ? "cleared" : "updated",
            goalId: goal.id,
            goal: committed,
            ...(action === "resume" ? { runId: "already-settled-run" } : {}),
            replayed: true,
          });
          await checkOutcome.waitFor({ state: "detached" });
          if (committed) {
            await page
              .getByRole("button", {
                name: action === "pause" ? "Resume goal" : "Pause goal",
                exact: true,
              })
              .waitFor();
          }
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          expect(await gateway.getRequests(method)).toHaveLength(1);
          await page.screenshot({ path: path.join(artifacts, "reconciled-goal.png") });
        },
      );
    },
  );
});
