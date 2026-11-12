import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../packages/gateway-protocol/src/client-info.js";
import { createTrackedProvider } from "../src/gateway/test-helpers.tracked-provider.js";
import { loadOrCreateDeviceIdentity } from "../src/infra/device-identity.js";
import { writeSecretStoreEntry } from "../src/secrets/store/secret-store.js";
import { connectProofClient } from "./helpers/gateway-integration-fixtures.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "./helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

const deniedTools = [
  "exec",
  "process",
  "code_execution",
  "write",
  "edit",
  "apply_patch",
  "computer",
];
const key = "synthetic-delegation-authority-key";
const secret = { source: "store", provider: "default", id: "DELEGATION_AUTHORITY_TEST_KEY" };

type Scenario = {
  name: string;
  agent: "restricted" | "allowed" | "full" | "grant" | "off" | "node";
  execAvailable: boolean;
  permissionMode?: "full";
  operation: { path: string; value: string };
  approval?: "allow-once" | "deny";
  logging: string;
};

type PersistedConfig = {
  logging: { level: string };
  agents: {
    entries: Record<"grant" | "off", { tools: { openclaw: { autoApproveChanges: boolean } } }>;
  };
};

function text(response: ServerResponse, value: string) {
  const id = randomUUID();
  writeOpenAiResponsesText(response, {
    text: value,
    messageId: `msg_${id}`,
    responseId: `resp_${id}`,
  });
}

function call(response: ServerResponse, args: Record<string, unknown>) {
  const id = randomUUID();
  const item = {
    type: "function_call",
    id: `fc_${id}`,
    call_id: `call_${id}`,
    name: "openclaw",
    arguments: JSON.stringify(args),
    status: "completed",
  };
  writeOpenAiResponsesSse(response, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", arguments: "" },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: item.id,
      output_index: 0,
      delta: item.arguments,
    },
    {
      type: "response.function_call_arguments.done",
      item_id: item.id,
      output_index: 0,
      arguments: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_${id}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}

// The fixture replaces only model HTTP responses. Tool assembly, caller authority,
// the delegated proposal, human decision, and persistent config writer are real.
it(
  "enforces delegated administration grants through the Gateway and agent runner",
  {
    timeout: 180_000,
  },
  async ({ signal, onTestFailed }) => {
    let active:
      | { scenario: Scenario; regularCalls: number; systemCalls: number; reply?: string }
      | undefined;
    let requested = createDeferred<string>();
    const approvals: Record<string, unknown>[] = [];
    const observations: unknown[] = [];
    let instance: OpenClawTestInstance | undefined;
    let client: Awaited<ReturnType<typeof connectProofClient>> | undefined;
    const provider = createTrackedProvider(
      (raw, response, request) => {
        expect(request.headers.authorization).toBe(`Bearer ${key}`);
        const body: unknown = JSON.parse(raw);
        if (!isRecord(body)) {
          throw new Error("Expected a Responses request object");
        }
        const tools = (Array.isArray(body.tools) ? body.tools : []).filter(isRecord);
        const tool = tools.find((entry) => entry.name === "openclaw");
        const parameters = isRecord(tool?.parameters) ? tool.parameters : {};
        const properties = isRecord(parameters.properties) ? parameters.properties : {};
        const regular = "message" in properties;
        const system = "action" in properties;
        if (!regular && !system) {
          text(response, "OK");
          return;
        }
        if (!active) {
          throw new Error("Unexpected model turn outside a scenario");
        }
        const input = (Array.isArray(body.input) ? body.input : []).filter(isRecord);
        const previous = input.findLast(
          (item) => item.type === "function_call" && item.name === "openclaw",
        );
        const output = previous
          ? input.find(
              (item) => item.type === "function_call_output" && item.call_id === previous.call_id,
            )
          : undefined;
        if (output) {
          observations.push({ scenario: active.scenario.name, system, toolOutput: output.output });
          if (regular) {
            active.reply =
              typeof output.output === "string" ? output.output : JSON.stringify(output.output);
          }
          text(response, "DELEGATION_DONE");
          return;
        }
        if (regular) {
          expect(++active.regularCalls).toBe(1);
          const names = tools.map((entry) => entry.name);
          observations.push({ scenario: active.scenario.name, tools: names });
          if (active.scenario.execAvailable) {
            expect(names).toContain("exec");
            expect(names).not.toContain("edit");
          } else {
            for (const name of deniedTools) {
              expect(names).not.toContain(name);
            }
          }
          call(response, {
            message: `Apply the requested configuration for ${active.scenario.name}.`,
          });
        } else {
          expect(++active.systemCalls).toBe(1);
          call(response, { action: "config_set", ...active.scenario.operation });
        }
      },
      { signal },
    );
    onTestFailed(() => {
      process.stderr.write(
        `${JSON.stringify({
          active,
          observations,
          approvals,
          providerErrors: provider.errors.map(String),
          logs: instance?.logs().slice(-12_000),
        })}\n`,
      );
    });
    await runQaGatewayFixture(
      async () => {
        const baseUrl = await provider.listen();
        instance = await createOpenClawTestInstance({
          name: "delegation-authority",
          signal,
          env: {
            OPENCLAW_SKIP_PROVIDERS: undefined,
            OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
            OPENCLAW_AGENT_RUNTIME: undefined,
            OPENCLAW_TEST_FAST: "1",
            OPENCLAW_SECRET_SENTINELS: "1",
            OPENAI_API_KEY: undefined,
            OPENAI_OAUTH_TOKEN: undefined,
            ANTHROPIC_API_KEY: undefined,
          },
          config: {
            plugins: { enabled: false },
            logging: { level: "info" },
            agents: {
              ownership: "explicit",
              defaults: {
                model: "fixture/probe-model",
                workspace: "~/workspace",
                skipBootstrap: true,
              },
              entries: {
                restricted: { tools: { deny: deniedTools } },
                allowed: { tools: { deny: ["write", "edit", "apply_patch"] } },
                full: { tools: { deny: deniedTools } },
                grant: { tools: { deny: deniedTools, openclaw: { autoApproveChanges: true } } },
                off: {
                  tools: {
                    deny: ["write", "edit", "apply_patch"],
                    openclaw: { autoApproveChanges: false },
                  },
                },
                node: {
                  tools: {
                    deny: ["write", "edit", "apply_patch"],
                    exec: { host: "node" },
                  },
                },
              },
            },
            tools: { profile: "full", exec: { mode: "full" }, codeMode: { enabled: false } },
            models: {
              providers: {
                fixture: {
                  api: "openai-responses",
                  baseUrl,
                  apiKey: secret,
                  request: { allowPrivateNetwork: true },
                  models: [
                    {
                      id: "probe-model",
                      name: "Delegation fixture",
                      reasoning: false,
                      input: ["text"],
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      contextWindow: 32000,
                      maxTokens: 1000,
                    },
                  ],
                },
              },
            },
          },
        });
        await writeSecretStoreEntry({
          scope: { kind: "team" },
          name: secret.id,
          value: key,
          kind: "secret",
          allowedHosts: ["127.0.0.1"],
          updatedBy: "test",
          database: { env: instance.env },
        });
        await instance.startGateway();
        client = await connectProofClient(instance, {
          signal,
          scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals"],
          caps: [GATEWAY_CLIENT_CAPS.APPROVALS],
          deviceIdentity: loadOrCreateDeviceIdentity({
            path: instance.state.statePath("delegation-client", "client", "credentials.sqlite"),
          }),
          onEvent(event) {
            if (event.event === "openclaw.approval.requested" && isRecord(event.payload)) {
              approvals.push(event.payload);
              if (typeof event.payload.id === "string") {
                requested.resolve(event.payload.id);
              }
            }
          },
        });
        const readConfig = async (): Promise<PersistedConfig> =>
          JSON.parse(await fs.readFile(instance!.configPath, "utf8"));
        const scenarios: Scenario[] = [
          {
            name: "restricted default",
            agent: "restricted",
            execAvailable: false,
            operation: { path: "logging.level", value: "warn" },
            approval: "allow-once",
            logging: "warn",
          },
          {
            name: "unrestricted default with edit denied",
            agent: "allowed",
            execAvailable: true,
            operation: { path: "logging.level", value: "debug" },
            logging: "debug",
          },
          {
            name: "explicit full with exec denied",
            agent: "full",
            execAvailable: false,
            permissionMode: "full",
            operation: { path: "logging.level", value: "error" },
            logging: "error",
          },
          {
            name: "standing delegation grant",
            agent: "grant",
            execAvailable: false,
            operation: { path: "logging.level", value: "info" },
            logging: "info",
          },
          {
            name: "explicit off overrides full",
            agent: "off",
            execAvailable: true,
            permissionMode: "full",
            operation: { path: "logging.level", value: "warn" },
            approval: "deny",
            logging: "info",
          },
          {
            name: "node execution does not authorize Gateway changes",
            agent: "node",
            execAvailable: true,
            operation: { path: "logging.level", value: "warn" },
            approval: "deny",
            logging: "info",
          },
          {
            name: "grant expansion through a parent config object",
            agent: "grant",
            execAvailable: false,
            operation: {
              path: "agents.entries.off.tools.openclaw",
              value: '{"autoApproveChanges":true}',
            },
            approval: "allow-once",
            logging: "info",
          },
          {
            name: "revoking its own standing grant",
            agent: "grant",
            execAvailable: false,
            operation: {
              path: "agents.entries.grant.tools.openclaw.autoApproveChanges",
              value: "false",
            },
            logging: "info",
          },
        ];
        for (const scenario of scenarios) {
          active = { scenario, regularCalls: 0, systemCalls: 0 };
          requested = createDeferred<string>();
          const approvalCount = approvals.length;
          const before = await readConfig();
          const sessionKey = `agent:${scenario.agent}:delegation-${randomUUID()}`;
          if (scenario.permissionMode) {
            await expect(
              client.request("sessions.patch", {
                key: sessionKey,
                permissionMode: scenario.permissionMode,
              }),
            ).resolves.toMatchObject({ entry: { permissionMode: "full" } });
          }
          const started = await client.request<{ runId: string; status: string }>("chat.send", {
            sessionKey,
            message: `Run ${scenario.name}.`,
            deliver: false,
            idempotencyKey: randomUUID(),
          });
          expect(started.status).toBe("started");
          const finished = client.request<{ status: string }>(
            "agent.wait",
            {
              runId: started.runId,
              timeoutMs: 120_000,
            },
            { timeoutMs: 125_000 },
          );
          if (scenario.approval) {
            const id = await withinTest(
              awaitGateBeforeSettlement(
                requested.promise,
                finished,
                `${scenario.name} settled before requesting approval`,
              ),
              signal,
            );
            const pending = await readConfig();
            expect(pending.logging.level).toBe(before.logging.level);
            expect(pending.agents.entries.off.tools.openclaw.autoApproveChanges).toBe(false);
            expect(approvals).toHaveLength(approvalCount + 1);
            await client.request("approval.resolve", {
              id,
              kind: "system-agent",
              decision: scenario.approval,
            });
          }
          expect(await withinTest(finished, signal)).toMatchObject({ status: "ok" });
          const after = await readConfig();
          observations.push({ scenario: scenario.name, logging: after.logging.level });
          expect(after.logging.level).toBe(scenario.logging);
          expect(approvals).toHaveLength(approvalCount + (scenario.approval ? 1 : 0));
          expect(active.regularCalls).toBe(1);
          expect(active.systemCalls).toBe(1);
          expect(active.reply).toBeDefined();
          expect(active.reply).not.toMatch(/unconfirmed|did not go through|failed to complete/i);
          expect(active.reply).toContain(
            scenario.approval === "deny" ? "Denied. No change." : "Updated ",
          );
          expect(provider.errors).toEqual([]);
        }
        expect((await readConfig()).agents.entries.off.tools.openclaw.autoApproveChanges).toBe(
          true,
        );
        expect((await readConfig()).agents.entries.grant.tools.openclaw.autoApproveChanges).toBe(
          false,
        );
      },
      () => client?.stopAndWait(),
      () => instance?.cleanup(),
      () => provider.close(),
    );
  },
);
