import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { json } from "node:stream/consumers";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished } from "vitest";
import { disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { loadOrCreateDeviceIdentity } from "../src/infra/device-identity.js";
import { GATEWAY_CLIENT_NAMES, GATEWAY_CLIENT_MODES } from "../src/utils/message-channel.js";
import { acquireGatewayTestClient } from "./helpers/gateway-client.js";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "./helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";

// A real Gateway and provider request catch preference-to-prompt wiring that
// publication renderer and profile-component tests cannot exercise.
it(
  "applies opt-in PR attribution to new agent sessions without GitHub coauthor identity",
  {
    timeout: 180_000,
  },
  async () => {
    const requests: unknown[] = [];
    const model = await startOpenAiResponsesModelServer({
      modelId: "pr-attribution-proof",
      bindError: "PR attribution proof model did not bind",
      onRequest: async (request, response) => {
        requests.push(await json(request));
        writeOpenAiResponsesText(response, {
          text: "Ready to help.",
          messageId: "message-" + requests.length,
          responseId: "response-" + requests.length,
        });
      },
    });
    onTestFinished(() => model.close());
    const modelConfig = createOpenAiResponsesModelConfig({
      baseUrl: model.baseUrl,
      providerId: "pr-attribution-proof",
      modelId: "pr-attribution-proof",
      reasoning: false,
      toolProfile: "minimal",
    });
    const profile = "pr-attribution-" + randomUUID();
    const instance = await createOpenClawTestInstance({
      name: profile,
      config: modelConfig,
      env: {
        OPENCLAW_PROFILE: profile,
        NO_PROXY: [process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(","),
        no_proxy: [process.env.no_proxy, "127.0.0.1", "localhost"].filter(Boolean).join(","),
        OPENCLAW_AGENT_RUNTIME: undefined,
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      },
    });
    try {
      await instance.state.writeConfig({
        ...modelConfig,
        gateway: {
          port: instance.port,
          auth: { mode: "token", token: instance.gatewayToken },
          controlUi: { enabled: false },
        },
        logging: { file: path.join(instance.stateDir, "gateway.log") },
      });
      await instance.startGateway();
      const { buildId } = asRecord(JSON.parse(await readFile("dist/build-info.json", "utf8")));
      if (typeof buildId !== "string") {
        throw new Error("Built Gateway identity is missing");
      }
      const client = await acquireGatewayTestClient(
        {
          url: instance.url,
          token: instance.gatewayToken,
          scopes: ["operator.admin", "operator.read", "operator.write"],
          requestTimeoutMs: 135_000,
          clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
          clientBuildId: buildId,
          mode: GATEWAY_CLIENT_MODES.UI,
          origin: instance.url.replace("ws:", "http:"),
          deviceIdentity: loadOrCreateDeviceIdentity({
            env: { OPENCLAW_STATE_DIR: instance.stateDir },
          }),
        },
        {
          timeoutMs: 60_000,
          timeoutMessage: "Attribution proof connection timed out",
          closeMessage: "Attribution proof connection closed",
        },
      );
      try {
        const run = async (label: string) => {
          const sessionKey = "agent:main:pr-attribution-" + label;
          await client.request("sessions.create", {
            key: sessionKey,
            agentId: "main",
            label: "PR attribution " + label,
            cwd: instance.state.workspaceDir,
          });
          const accepted = await client.request<{ runId: string }>("chat.send", {
            sessionKey,
            message: "Say you are ready to help.",
            idempotencyKey: randomUUID(),
          });
          const completed = await client.request("agent.wait", {
            runId: accepted.runId,
            timeoutMs: 120_000,
          });
          expect(
            completed,
            `${requests.length} provider requests; ${JSON.stringify(completed)}; ${instance.logs()}`,
          ).toMatchObject({ status: "ok" });
          return JSON.stringify(requests.at(-1));
        };
        expect(await run("default")).not.toContain("Made with [OpenClaw]");
        expect(
          await client.request("users.prefs.set", {
            entries: { "github.prAttribution.enabled": true },
          }),
        ).toMatchObject({ status: "ok" });
        expect(await run("enabled")).toContain("🦞 Made with [OpenClaw](https://openclaw.ai)");
        expect(
          await client.request("users.prefs.set", {
            entries: { "github.prAttribution.enabled": false },
          }),
        ).toMatchObject({ status: "ok" });
        expect(await run("disabled")).not.toContain("Made with [OpenClaw]");
        expect(requests).toHaveLength(3);
      } finally {
        await disconnectGatewayClient(client);
      }
    } finally {
      await instance.cleanup();
    }
  },
);
