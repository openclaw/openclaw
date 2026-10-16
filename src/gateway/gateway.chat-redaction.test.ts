import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { setTestEnvValue } from "../test-utils/env.js";
import {
  closeChatFixture,
  sendChatAndWait,
  startControlUiGateway,
} from "./gateway-chat-fixture.test-support.js";
import { listenProvider, readProviderBody } from "./gateway-provider-fixture.test-support.js";
import {
  createGatewayConfigPath,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import type { startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

type TextMessage = {
  role?: string;
  content?: string | Array<{ type: string; text?: string }>;
};

function userText(messages: TextMessage[]): string {
  return messages
    .filter((message) => message.role === "user")
    .flatMap(({ content }) =>
      typeof content === "string"
        ? [content]
        : (content ?? []).flatMap((block) => (typeof block.text === "string" ? [block.text] : [])),
    )
    .join("\n");
}

const publicUrl = "https://x.com/EliXPampa/status/2097727549400871286";
const secret = "Ab9Q".repeat(10);
const numericSlashSecret = "1234/" + "Ab9Q".repeat(8) + "Ab9";
const slashSecret = "Aa0/".repeat(10);

describe("registered Control UI chat text fidelity", () => {
  const requests: string[] = [];
  const providerErrors: unknown[] = [];
  const provider = createServer((request, response) => {
    void (async () => {
      requests.push(await readProviderBody(request));
      writeOpenAiResponsesText(response, {
        text: "Fixture reply complete.",
        messageId: `msg_${randomUUID()}`,
        responseId: `resp_${randomUUID()}`,
      });
    })().catch((error: unknown) => {
      providerErrors.push(error);
      response.writeHead(500).end("fixture provider failed");
    });
  });
  let home: Awaited<ReturnType<typeof setupGatewayTempHome>>;
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>>;

  beforeAll(async () => {
    resetGatewayTestState();
    home = await setupGatewayTempHome({ prefix: "openclaw-chat-redaction-" });
    const model = buildMockOpenAiResponsesProvider(
      await listenProvider(provider),
      "redaction-fixture",
    );
    const token = randomUUID();
    setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);
    const cfg = {
      agents: {
        defaults: {
          workspace: home.workspaceDir,
          skipBootstrap: true,
          model: { primary: model.modelRef },
          models: { [model.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } } },
        },
      },
      models: { mode: "replace", providers: { [model.providerId]: model.config } },
      gateway: { auth: { mode: "token", token } },
      hooks: { enabled: false },
    } satisfies OpenClawConfig;
    const configPath = await createGatewayConfigPath(home.tempHome);
    gateway = await startControlUiGateway({
      cfg,
      configPath,
      token,
      clientDisplayName: "chat-redaction-test",
    });
    await gateway.server.startupSettled;
  }, 90_000);

  afterAll(() =>
    closeChatFixture(
      gateway,
      provider,
      home,
      "chat redaction tests complete",
      resetSecretRedactionRegistryForTest,
    ),
  );

  async function expectStoredAndSent(message: string): Promise<void> {
    const sessionKey = `agent:main:redaction-${randomUUID()}`;
    // The first turn creates the session; the regression affects subsequent admission.
    await sendChatAndWait(gateway.client, sessionKey, "Initialize this fixture conversation.");
    const requestStart = requests.length;
    await sendChatAndWait(gateway.client, sessionKey, message);
    const history = await gateway.client.request<{ messages: TextMessage[] }>("chat.history", {
      sessionKey,
    });
    expect.soft(userText(history.messages), "chat.history").toContain(message);
    expect(providerErrors).toEqual([]);
    const turnRequests = requests.slice(requestStart);
    expect(turnRequests).toHaveLength(1);
    const body = JSON.parse(turnRequests[0]!) as { input: TextMessage[] };
    expect.soft(userText(body.input), "recorded model input").toContain(message);
  }

  it.each([
    ["public URL", publicUrl],
    ["URL path with at sign", `https://example.test/${secret}@latest`],
    ["URL path with query", `https://example.test/path-${secret}?foo=@`],
    ["nested JSON URLs", JSON.stringify(JSON.stringify([`${publicUrl}?safe=1`, publicUrl]))],
    ["bare credential", secret],
    ["unknown URL query", `https://example.test/?foo=.${secret}`],
    [
      "URL in parenthesized query value",
      `https://example.test/?next=(https://example.test/path-${secret})`,
    ],
    ["userinfo before punctuation", `https://name-${secret})@example.test`],
    ["s3 numeric slash password", `s3://user:${numericSlashSecret}@bucket`],
    ["s3 slash-prefixed key", `s3://user:1234/${secret}@bucket`],
    ["slash credential after URL", `${publicUrl} ${slashSecret}`],
    ["credential query", `https://example.test/?SecretAccessKey=${secret}`],
    ["credential field", `{"awsSecretAccessKey":"${secret}"}`],
    ["credential after Markdown link", `[docs](${publicUrl})${secret}`],
  ])(
    "chat.send preserves the %s in chat.history and recorded model input",
    (_label, input) => expectStoredAndSent(input),
    90_000,
  );

  it("exec.approval.request preserves command bytes in the exec.approval.get display", async () => {
    const command = [
      "printf '%s'",
      JSON.stringify("API_TOKEN = computeToken()"),
      JSON.stringify(`${publicUrl} ${secret}`),
      JSON.stringify(`s3://user:${numericSlashSecret}@bucket`),
    ].join(" ");
    const accepted = await gateway.client.request<{ status: string; id: string }>(
      "exec.approval.request",
      {
        command,
        host: "gateway",
        twoPhase: true,
        requireDeliveryRoute: false,
        suppressDelivery: true,
      },
      { expectFinal: false },
    );
    expect(accepted.status).toBe("accepted");
    try {
      const display = await gateway.client.request<{ commandText: string }>("exec.approval.get", {
        id: accepted.id,
      });
      expect(display.commandText).toBe(command);
    } finally {
      await gateway.client.request("exec.approval.resolve", { id: accepted.id, decision: "deny" });
    }
  });

  it("chat.send preserves a registered URL value in chat.history and recorded model input", async () => {
    const registered = "synthetic-registered-value";
    registerSecretValueForRedaction(registered);
    await expectStoredAndSent(`https://example.test/${registered}`);
  }, 90_000);
});
