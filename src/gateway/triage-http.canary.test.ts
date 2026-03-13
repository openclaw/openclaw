import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createGatewayHttpServer } from "./server-http.js";
import type { LaneExecutorDeps } from "./lane-executors.js";
import { withTempConfig } from "./test-temp-config.js";

const AUTH_NONE = {
  mode: "none",
  token: undefined,
  password: undefined,
  allowTailscale: false,
} as const;

async function listen(server: HttpServer): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

describe("POST /api/triage canary", () => {
  it("covers billing, maintenance, and escalation flows", async () => {
    await withTempConfig({
      prefix: "triage-canary",
      cfg: { gateway: { trustedProxies: [] } },
      run: async () => {
        const triageLaneDeps: LaneExecutorDeps = {
          executeApiIntent: async (input) => ({
            ok: true,
            data: { intent: input.intentSlug, currentBalance: 315.22 },
            sourceLatencyMs: 22,
          }),
          runLowLlm: async (input) => ({
            text: `Low-LLM response for ${input.intentSlug}`,
            promptTokens: 32,
            completionTokens: 18,
          }),
          runHighLlm: async (input) => ({
            text: `High-LLM response for ${input.intentSlug}`,
            promptTokens: 128,
            completionTokens: 56,
          }),
        };

        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "/__control__",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth: AUTH_NONE,
          triageLaneDeps,
          triageIdentityLookup: async () => [
            {
              subjectId: "SUB-CANARY-1",
              role: "renter",
              allowedPropertyIds: ["P1"],
              allowedUnitIds: ["402"],
              identityConfidence: "high",
            },
          ],
        });

        const port = await listen(server);
        try {
          const billingRes = await fetch(`http://127.0.0.1:${port}/api/triage`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-openclaw-verified": "true",
            },
            body: JSON.stringify({
              message: "What is my current balance?",
              intentSlug: "current_balance",
              actionType: "read",
              executionHint: "api-first",
              hasRequiredEntities: true,
              entities: { unitId: "402" },
              isFinancial: true,
            }),
          });
          expect(billingRes.status).toBe(200);
          const billing = (await billingRes.json()) as Record<string, unknown>;
          expect(billing).toMatchObject({
            decision: "allow",
            lane: "api_only",
            status: "ok",
          });

          const maintenanceRes = await fetch(`http://127.0.0.1:${port}/api/triage`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-openclaw-verified": "true",
            },
            body: JSON.stringify({
              message: "Can you summarize my maintenance request status?",
              intentSlug: "maintenance_status",
              actionType: "read",
              executionHint: "api+light-llm",
              hasRequiredEntities: false,
              isFinancial: false,
              confidence: { identity: 0.6, intent: 0.7, entity: 0.25 },
              apiDataAvailability: 0.2,
              lowLlmDataAvailability: 0.8,
              highLlmDataAvailability: 0.7,
            }),
          });
          expect(maintenanceRes.status).toBe(200);
          const maintenance = (await maintenanceRes.json()) as Record<string, unknown>;
          expect(maintenance).toMatchObject({
            decision: "allow",
            lane: "low_llm",
            status: "ok",
          });

          const escalationRes = await fetch(`http://127.0.0.1:${port}/api/triage`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({
              message: "Give me payoff details",
              intentSlug: "payoff_amount",
              actionType: "read",
              executionHint: "api-first",
              hasRequiredEntities: true,
              entities: { unitId: "402" },
              isFinancial: true,
            }),
          });
          expect(escalationRes.status).toBe(401);
          const escalation = (await escalationRes.json()) as Record<string, unknown>;
          expect(escalation).toMatchObject({
            decision: "stepup",
          });
        } finally {
          await closeServer(server);
        }
      },
    });
  });
});