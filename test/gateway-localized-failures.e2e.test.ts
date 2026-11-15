import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { json } from "node:stream/consumers";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished } from "vitest";
import { disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { loadOrCreateDeviceIdentity } from "../src/infra/device-identity.js";
import { GATEWAY_CLIENT_NAMES, GATEWAY_CLIENT_MODES } from "../src/utils/message-channel.js";
import { writeRestartToolCall } from "./gateway-restart.test-support.js";
import { acquireGatewayTestClient } from "./helpers/gateway-client.js";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "./helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";

// Exercise real HTTP model requests, a failed read tool, Gateway delivery, and
// durable personal preferences. This does not send messages to an external channel.
// OPENCLAW_TEST_LOCALIZATION_BASELINE may name a published openclaw.mjs to seed
// existing state before the current CLI runs its ordinary Doctor migrations.
it(
  "delivers localized model failures and preserves preferences across a Gateway restart",
  { timeout: 240_000 },
  async ({ signal }) => {
    const baselinePath = process.env.OPENCLAW_TEST_LOCALIZATION_BASELINE;
    const entrypoint = baselinePath ? [path.resolve(baselinePath)] : undefined;
    let baselineMode = Boolean(baselinePath);
    let replayedBaseline = false;
    let requests = 0;
    let failedReads = 0;
    const model = await startOpenAiResponsesModelServer({
      modelId: "locale-proof",
      bindError: "Locale proof model did not bind",
      onRequest: async (request, response) => {
        const body = await json(request);
        requests++;
        if (baselineMode) {
          writeOpenAiResponsesText(response, {
            text: "Existing transcript",
            messageId: "legacy-message",
            responseId: "legacy-response",
          });
          return;
        }
        replayedBaseline ||= JSON.stringify(body).includes("Existing transcript");
        if (!JSON.stringify(body).includes("function_call_output")) {
          writeRestartToolCall(
            response,
            "locale",
            "read",
            { path: "missing-locale-proof.txt" },
            requests,
          );
          return;
        }
        if (JSON.stringify(body).includes("File not found:")) {
          failedReads++;
        }
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: "synthetic request rejected", type: "invalid_request_error" },
          }),
        );
      },
    });
    onTestFinished(() => model.close());
    const modelConfig = createOpenAiResponsesModelConfig({
      baseUrl: model.baseUrl,
      providerId: "locale-proof",
      modelId: "locale-proof",
      reasoning: false,
      toolProfile: "coding",
    });
    const instance = await createOpenClawTestInstance({
      name: "localized-failures-" + randomUUID(),
      signal,
      entrypoint,
      config: baselinePath ? modelConfig : { ...modelConfig, messages: { locale: "de" } },
      env: {
        OPENCLAW_AGENT_RUNTIME: undefined,
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      },
    });
    const initialConfig = JSON.parse(await readFile(instance.configPath, "utf8"));
    initialConfig.logging = {
      ...initialConfig.logging,
      file: path.join(instance.stateDir, "gateway.log"),
    };
    await instance.state.writeConfig(initialConfig);
    const events: Array<Record<string, unknown>> = [];
    const deviceIdentity = loadOrCreateDeviceIdentity({
      env: { OPENCLAW_STATE_DIR: instance.stateDir },
    });
    const connect = async () => {
      const infoPath =
        baselineMode && baselinePath
          ? path.join(path.dirname(path.resolve(baselinePath)), "dist/build-info.json")
          : path.resolve("dist/build-info.json");
      const info = asOptionalRecord(JSON.parse(await readFile(infoPath, "utf8")));
      if (typeof info?.buildId !== "string") {
        throw new Error("Missing Gateway build identity");
      }
      return acquireGatewayTestClient(
        {
          url: instance.url,
          token: instance.gatewayToken,
          scopes: ["operator.admin", "operator.read", "operator.write"],
          requestTimeoutMs: 100_000,
          clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
          mode: GATEWAY_CLIENT_MODES.UI,
          clientBuildId: info.buildId,
          origin: instance.url.replace("ws:", "http:"),
          deviceIdentity,
          onEvent: (event) => {
            const payload = asOptionalRecord(event.payload);
            if (event.event === "chat" && payload) {
              events.push(payload);
            }
          },
        },
        {
          timeoutMs: 60_000,
          timeoutMessage: "Locale proof connection timed out",
          closeMessage: "Locale proof connection closed",
          signal,
        },
      );
    };
    let client: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      await instance.startGateway();
      client = await connect();
      const run = async (label: string, expected: string, existing = false) => {
        if (!client) {
          throw new Error("Missing proof client");
        }
        const sessionKey = `agent:main:locale-proof-${label}`;
        if (!existing) {
          await client.request("sessions.create", {
            key: sessionKey,
            agentId: "main",
            label,
            cwd: instance.state.workspaceDir,
          });
        }
        const before = requests;
        const accepted = await client.request<{ runId: string }>("chat.send", {
          sessionKey,
          message: "Read missing-locale-proof.txt once and report the result.",
          idempotencyKey: randomUUID(),
        });
        const completed = await client
          .request("agent.wait", {
            runId: accepted.runId,
            timeoutMs: 90_000,
          })
          .catch((cause: unknown) => {
            throw new Error(
              `Locale proof failed after ${requests - before} requests and ${failedReads} failed reads.\n${instance.logs()}`,
              { cause },
            );
          });
        expect(completed, instance.logs()).toMatchObject({ status: baselineMode ? "ok" : "error" });
        await expect
          .poll(
            () =>
              events.find(
                (event) =>
                  event.runId === accepted.runId &&
                  (event.state === "final" || event.state === "error"),
              ),
            { timeout: 5_000 },
          )
          .toBeDefined();
        const terminal = events.find(
          (event) =>
            event.runId === accepted.runId && (event.state === "final" || event.state === "error"),
        );
        const visible = JSON.stringify(terminal?.message ?? terminal?.errorMessage);
        expect(visible, JSON.stringify(terminal)).toContain(expected);
        expect(requests).toBeGreaterThan(before);
        process.stdout.write(`[locale-gateway-proof] ${label}: ${visible}\n`);
      };
      if (entrypoint) {
        expect(
          await client.request("users.prefs.set", { entries: { "proof.saved": "kept" } }),
        ).toMatchObject({ status: "ok" });
        await run("legacy", "Existing transcript");
        await disconnectGatewayClient(client);
        client = undefined;
        await instance.stopGateway();
        baselineMode = false;
        entrypoint[0] = path.resolve("openclaw.mjs");
        const legacyConfig = JSON.parse(await readFile(instance.configPath, "utf8"));
        legacyConfig.messages = { ...legacyConfig.messages, locale: "de" };
        await instance.state.writeConfig(legacyConfig);
        const migrated = await instance.cli(["doctor", "--fix", "--non-interactive"], {
          timeoutMs: 120_000,
        });
        expect(migrated.code, migrated.stdout + migrated.stderr).toBe(0);
        await instance.startGateway();
        client = await connect();
        expect(await client.request("users.prefs.get", {})).toMatchObject({
          entries: { "proof.saved": "kept" },
        });
        expect(
          JSON.stringify(
            await client.request("chat.history", { sessionKey: "agent:main:locale-proof-legacy" }),
          ),
        ).toContain("Existing transcript");
        process.stdout.write(
          "[locale-upgrade-proof] Doctor completed; existing preference and transcript are readable.\n",
        );
        await run("legacy", "Modellanfrage abgewiesen: synthetic request rejected", true);
        expect(replayedBaseline).toBe(true);
      } else {
        await run("global-de", "Modellanfrage abgewiesen: synthetic request rejected");
      }
      expect(
        await client.request("users.prefs.set", {
          entries: { "messages.locale": "en", "proof.saved": "kept" },
        }),
      ).toMatchObject({ status: "ok" });
      await run("personal-en", "LLM request rejected: synthetic request rejected");
      await disconnectGatewayClient(client);
      client = undefined;
      await instance.stopGateway();
      const savedConfig = JSON.parse(await readFile(instance.configPath, "utf8"));
      delete savedConfig.messages.locale;
      await instance.state.writeConfig(savedConfig);
      await instance.startGateway();
      client = await connect();
      expect(await client.request("users.prefs.get", {})).toMatchObject({
        status: "ok",
        entries: { "messages.locale": "en", "proof.saved": "kept" },
      });
      expect(
        await client.request("users.prefs.set", { entries: { "messages.locale": null } }),
      ).toMatchObject({ status: "ok" });
      await run(
        "english-fallback-after-restart",
        "LLM request rejected: synthetic request rejected",
      );
      expect(failedReads).toBeGreaterThanOrEqual(3);
    } finally {
      if (client) {
        await disconnectGatewayClient(client);
      }
      await instance.cleanup();
    }
  },
);
