import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  createGatewayConfigPath,
  removeGatewayTempHome,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import {
  disconnectGatewayClient,
  getGatewayE2ePortBlock,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";
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
const masked = "Ab9QAb…Ab9Q";
const slashSecret = "Aa0/".repeat(10);

describe("registered Control UI chat redaction", () => {
  const requests: string[] = [];
  const providerErrors: unknown[] = [];
  const provider = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      requests.push(Buffer.concat(chunks).toString("utf8"));
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
    await new Promise<void>((resolve, reject) => {
      provider.once("error", reject);
      provider.listen(0, "127.0.0.1", resolve);
    });
    const address = provider.address();
    if (!address || typeof address === "string") {
      throw new Error("fixture provider did not bind");
    }
    const model = buildMockOpenAiResponsesProvider(
      `http://127.0.0.1:${address.port}/v1`,
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
    const port = await getGatewayE2ePortBlock();
    gateway = await startGatewayWithClient({
      cfg,
      port,
      clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      origin: `http://127.0.0.1:${port}`,
      configPath: await createGatewayConfigPath(home.tempHome),
      token,
      clientDisplayName: "chat-redaction-test",
    });
    await gateway.server.startupSettled;
  }, 90_000);

  afterAll(async () => {
    try {
      if (gateway) {
        try {
          await disconnectGatewayClient(gateway.client);
        } finally {
          await gateway.server.close({ reason: "chat redaction tests complete" });
        }
      }
    } finally {
      provider.closeAllConnections();
      await new Promise<void>((resolve) => {
        provider.close(() => resolve());
      });
      resetSecretRedactionRegistryForTest();
      resetGatewayTestState();
      if (home) {
        await removeGatewayTempHome(home.tempHome);
        home.envSnapshot.restore();
      }
    }
  });

  async function send(sessionKey: string, message: string): Promise<void> {
    const accepted = await gateway.client.request<{ runId: string; status: string }>("chat.send", {
      sessionKey,
      message,
      deliver: false,
      idempotencyKey: randomUUID(),
    });
    expect(accepted.status).toBe("started");
    const completed = await gateway.client.request<{ status: string }>(
      "agent.wait",
      { runId: accepted.runId, timeoutMs: 30_000 },
      { timeoutMs: 35_000 },
    );
    expect(completed.status).toBe("ok");
  }

  async function expectStoredAndSent(
    message: string,
    expected: string,
    hiddenValues: readonly string[] = [],
  ): Promise<void> {
    const sessionKey = `agent:main:redaction-${randomUUID()}`;
    // The first turn creates the session; the regression affects subsequent admission.
    await send(sessionKey, "Initialize this fixture conversation.");
    const requestStart = requests.length;
    await send(sessionKey, message);
    const history = await gateway.client.request<{ messages: TextMessage[] }>("chat.history", {
      sessionKey,
    });
    expect.soft(userText(history.messages), "chat.history").toContain(expected);
    expect(providerErrors).toEqual([]);
    const turnRequests = requests.slice(requestStart);
    expect(turnRequests).toHaveLength(1);
    const body = JSON.parse(turnRequests[0]!) as { input: TextMessage[] };
    expect.soft(userText(body.input), "recorded model input").toContain(expected);
    for (const value of hiddenValues) {
      expect.soft(userText(history.messages), "chat.history").not.toContain(value);
      expect.soft(userText(body.input), "recorded model input").not.toContain(value);
    }
  }

  it.each([
    publicUrl,
    `https://example.test/${secret}`,
    `https://example.test/path-${secret}`,
    `https://${secret}.example.test`,
    "https://x.com/@user/status/2097727549400871286",
    `https://x.com/@user/status/${secret}`,
    `data:application/octet-stream;base64,AAAA/${secret}@`,
    `https://example.test:8080/path-${secret}`,
  ])(
    "chat.send preserves %s in chat.history and recorded model input",
    async (url) => {
      await expectStoredAndSent(url, url);
    },
    90_000,
  );

  it.each([
    ["bare credential", secret, masked],
    ["URL fragment", `https://example.test/#${secret}`, `https://example.test/#${masked}`],
    [
      "unknown URL query",
      `https://example.test/?foo=.${secret}`,
      `https://example.test/?foo=.${masked}`,
    ],
    [
      "adjacent Markdown label",
      `https://example.test/[${secret}](target)`,
      `https://example.test/[${masked}](target)`,
    ],
    [
      "adjacent parenthesis",
      `https://example.test/(${secret})`,
      `https://example.test/(${masked})`,
    ],
    ["adjacent brace", `https://example.test/{${secret}}`, `https://example.test/{${masked}}`],
    [
      "URL inside query",
      `https://example.test/?next=https://example.test/path-${secret}`,
      `https://example.test/?next=https://example.test/path-${masked}`,
    ],
    [
      "URL inside fragment",
      `https://example.test/#https://example.test/path-${secret}`,
      `https://example.test/#https://example.test/path-${masked}`,
    ],
    [
      "at-sign beyond query cutoff",
      `https://example.test/path-${secret}?foo=@`,
      `https://example.test/path-${masked}?foo=@`,
    ],
    ...[")", "]", "}", "|", "\x60", "\x27", '"', "<", ">"].map((punctuation) => [
      `userinfo before ${punctuation}`,
      `https://name-${secret}${punctuation}@example.test`,
      `https://name-${masked}${punctuation}@example.test`,
    ]),
    ["s3 password", `s3://user:${secret}@bucket`, `s3://user:${masked}@bucket`],
    ["s3 username", `s3://name-${secret}:pass@bucket`, `s3://name-${masked}:pass@bucket`],
    [
      "s3 password with an at-sign",
      `s3://user:part@${secret}@bucket`,
      `s3://user:part@${masked}@bucket`,
    ],
    [
      "s3 numeric slash password",
      `s3://user:${numericSlashSecret}@bucket`,
      "s3://user:1234/A…QAb9@bucket",
    ],
    ["s3 slash-prefixed key", `s3://user:1234/${secret}@bucket`, `s3://user:1234/${masked}@bucket`],
    ["dot-prefixed credential", `.${secret}`, `.${masked}`],
    ["credential after URL", `${publicUrl} ${secret}`, `${publicUrl} ${masked}`],
    ["credential before URL", `${secret} ${publicUrl}`, `${masked} ${publicUrl}`],
    ["slash credential after URL", `${publicUrl} ${slashSecret}`, `${publicUrl} Aa0/Aa…Aa0/`],
    [
      "credential query",
      `https://example.test/?SecretAccessKey=${secret}`,
      `https://example.test/?SecretAccessKey=${masked}`,
    ],
    [
      "credential field",
      `{"awsSecretAccessKey":"${secret}"}`,
      `{"awsSecretAccessKey":"${masked}"}`,
    ],
    [
      "credential after Markdown link",
      `[docs](${publicUrl})${secret}`,
      `[docs](${publicUrl})${masked}`,
    ],
    [
      "credential after Markdown punctuation",
      `[docs](${publicUrl});${secret}`,
      `[docs](${publicUrl});${masked}`,
    ],
    ["credential in table", `|${publicUrl}|${secret}|`, `|${publicUrl}|${masked}|`],
  ])(
    "chat.send masks the %s in chat.history and recorded model input",
    async (_label, input, expected) => {
      await expectStoredAndSent(input, expected, [secret, slashSecret, numericSlashSecret]);
    },
    90_000,
  );

  it("exec.approval.request preserves URLs and masks credentials in the exec.approval.get display", async () => {
    const urls = [
      publicUrl,
      `https://example.test/${secret}`,
      `https://example.test/path-${secret}`,
      `https://${secret}.example.test`,
      "https://x.com/@user/status/2097727549400871286",
      `https://x.com/@user/status/${secret}`,
      `data:application/octet-stream;base64,AAAA/${secret}@`,
      `https://example.test:8080/path-${secret}`,
    ];
    // A separate spliced token forces the approval sanitizer's bitmap-union display.
    const command = [
      "printf '%s'",
      ...urls.map((url) => JSON.stringify(url)),
      JSON.stringify(`${publicUrl} ${secret}`),
      JSON.stringify(`.${secret}`),
      JSON.stringify(`s3://user:${secret}@bucket`),
      JSON.stringify(`s3://user:1234/${secret}@bucket`),
      ...["#", "?foo=.", "[", "(", "{"].map((prefix) =>
        JSON.stringify(`https://example.test/${prefix}${secret}`),
      ),
      ...[")", "]", "}", "|", "\x60", "\x27", '"', "<", ">"].map((punctuation) =>
        JSON.stringify(`https://name-${secret}${punctuation}@example.test`),
      ),
      JSON.stringify("sk-abc123\u200B456789012345678"),
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
      for (const url of urls) {
        expect(display.commandText).toContain(url);
      }
      expect(display.commandText).toContain(`"${publicUrl} ***"`);
      expect(display.commandText).toContain('".***"');
      expect(display.commandText).toContain('"s3://user:***@bucket"');
      expect(display.commandText).toContain('"s3://user:1234/***@bucket"');
      expect(display.commandText).not.toContain("sk-abc123");
      for (const prefix of ["#", "?foo=.", "[", "(", "{"]) {
        expect(display.commandText).toContain(`"https://example.test/${prefix}***"`);
      }
      for (const punctuation of [")", "]", "}", "|", "\x60", "\x27", '"', "<", ">"]) {
        expect(display.commandText).toContain(
          JSON.stringify(`https://name-***${punctuation}@example.test`),
        );
      }
      expect(display.commandText).not.toContain("456789012345678");
    } finally {
      await gateway.client.request("exec.approval.resolve", { id: accepted.id, decision: "deny" });
    }
  });

  it("chat.send masks a registered URL value in chat.history and recorded model input", async () => {
    const registered = "synthetic-registered-value";
    registerSecretValueForRedaction(registered);
    await expectStoredAndSent(
      `https://example.test/${registered}`,
      "https://example.test/synthe…alue",
      [registered],
    );
  }, 90_000);
});
