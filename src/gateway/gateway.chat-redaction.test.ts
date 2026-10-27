import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { createChatFixture, sendChatAndWait } from "./gateway-chat-fixture.test-support.js";

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

describe("registered Control UI chat text fidelity", () => {
  const fixture = createChatFixture("chat-redaction", {
    reset: resetSecretRedactionRegistryForTest,
  });
  beforeAll(() => fixture.start(), 90_000);
  afterAll(() => fixture.close());

  async function expectStoredAndSent(message: string): Promise<void> {
    const sessionKey = `agent:main:redaction-${randomUUID()}`;
    // The first turn creates the session; the regression affects subsequent admission.
    await sendChatAndWait(fixture.client, sessionKey, "Initialize this fixture conversation.");
    const requestStart = fixture.requests.length;
    await sendChatAndWait(fixture.client, sessionKey, message);
    const history = await fixture.client.request<{ messages: TextMessage[] }>("chat.history", {
      sessionKey,
    });
    expect.soft(userText(history.messages), "chat.history").toContain(message);
    expect(fixture.errors).toEqual([]);
    const turnRequests = fixture.requests.slice(requestStart);
    expect(turnRequests).toHaveLength(1);
    const body = JSON.parse(turnRequests[0]!) as { input: TextMessage[] };
    expect.soft(userText(body.input), "recorded model input").toContain(message);
  }

  it(
    "chat.send preserves credential-shaped text in chat.history and recorded model input",
    () => expectStoredAndSent(secret),
    90_000,
  );

  it("exec.approval.request preserves command bytes in the exec.approval.get display", async () => {
    const command = `printf '%s' "API_TOKEN = computeToken()" "${publicUrl} ${secret}" "s3://user:${numericSlashSecret}@bucket"`;
    const accepted = await fixture.client.request<{ status: string; id: string }>(
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
      const display = await fixture.client.request<{ commandText: string }>("exec.approval.get", {
        id: accepted.id,
      });
      expect(display.commandText).toBe(command);
    } finally {
      await fixture.client.request("exec.approval.resolve", { id: accepted.id, decision: "deny" });
    }
  });

  it("chat.send preserves a registered URL value in chat.history and recorded model input", async () => {
    const registered = "synthetic-registered-value";
    registerSecretValueForRedaction(registered);
    await expectStoredAndSent(`https://example.test/${registered}`);
  }, 90_000);
});
