import { createHash, randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { isInternalRuntimeContextCarrierText } from "../../../../extensions/qa-lab/api.js";
import { createQaLiveLaneGateway } from "../../../../extensions/qa-lab/runtime-api.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { sendChat, waitForRun } from "./gateway-recovery.test-support.js";

const requestsSchema = z.array(
  z.object({
    cursor: z.number().int(),
    model: z.string(),
    raw: z.string(),
    outcome: z.string(),
    errorCode: z.string().optional(),
  }),
);
const inputSchema = z.object({
  previous_response_id: z.string().optional(),
  input: z.array(z.record(z.string(), z.unknown())),
});

let gatewayOwner: ReturnType<typeof createQaLiveLaneGateway> | undefined;

afterEach(async () => {
  if (gatewayOwner) {
    await stopQaGatewayFixture(gatewayOwner);
  }
  gatewayOwner = undefined;
});

function describeItem(item: Record<string, unknown> | undefined): string {
  if (!item) {
    return "<absent>";
  }
  const kind = [item.role, item.type].filter((value) => typeof value === "string").join("/");
  const digest = createHash("sha256").update(JSON.stringify(item)).digest("hex").slice(0, 16);
  return `${kind || "?"} sha256:${digest}`;
}

// The turn-scoped runtime context rides after the newest prompt and is not replayed later.
function isRuntimeContextCarrier(item: Record<string, unknown>): boolean {
  const content = item.content;
  return (
    item.role === "user" &&
    Array.isArray(content) &&
    content.length === 1 &&
    typeof content[0]?.text === "string" &&
    isInternalRuntimeContextCarrierText(content[0].text)
  );
}

// Prompt caches hit only when each request extends the bytes of the one before it.
function firstPrefixBreak(previous: unknown[], current: unknown[]): number {
  return previous.findIndex(
    (item, index) => JSON.stringify(item) !== JSON.stringify(current[index]),
  );
}

it(
  "keeps the provider input prefix across a rate-limited tool continuation retry",
  { timeout: 180_000 },
  async () => {
    gatewayOwner = createQaLiveLaneGateway();
    const { gateway, mock } = await gatewayOwner.start({
      repoRoot: process.cwd(),
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      transport: { requiredPluginIds: [], createGatewayConfig: () => ({}) },
      transportBaseUrl: "http://127.0.0.1",
      controlUiEnabled: false,
    });
    const provider = expectDefined(mock, "mock provider");
    const sessionKey = `agent:qa:gateway-rate-limit-cache-${randomUUID()}`;
    const marker = randomUUID();
    const turns = [
      `Provider HTTP 429 after tool QA check ${marker}: read QA_KICKOFF_TASK.md, then reply.`,
      "Gateway chat RPC QA. Reply exactly `RATE_LIMIT_CACHE_TURN_TWO_OK`.",
    ];

    for (const message of turns) {
      const started = await sendChat(gateway, sessionKey, message);
      expect(started.status).toBe("started");
      expect(await waitForRun(gateway, started.runId)).toMatchObject({ status: "ok" });
    }
    const response = await fetch(`${provider.baseUrl}/debug/requests`);
    const requests = requestsSchema
      .parse(await response.json())
      .filter((entry) => entry.model === "gpt-5.6-luna" && entry.raw.includes(marker))
      .toSorted((a, b) => a.cursor - b.cursor);
    expect(
      requests.filter((entry) => entry.errorCode === "rate_limit_exceeded"),
      "the tool continuation was rate limited",
    ).toHaveLength(1);
    expect(requests.at(-1)?.raw).toContain("RATE_LIMIT_CACHE_TURN_TWO_OK");

    // The SSE mock route is stateless, so every request carries its full input.
    const inputs = requests.map((entry) => {
      const body = inputSchema.parse(JSON.parse(entry.raw));
      expect(body.previous_response_id).toBeUndefined();
      return body.input.filter((item) => !isRuntimeContextCarrier(item));
    });
    const breaks = inputs.slice(1).flatMap((current, offset) => {
      const previous = inputs[offset]!;
      const index = firstPrefixBreak(previous, current);
      return index < 0
        ? []
        : [
            `request ${offset + 2} (cursor ${requests[offset + 1]!.cursor}) breaks request ` +
              `${offset + 1} prefix at input[${index}]: was ${describeItem(previous[index])}, ` +
              `now ${describeItem(current[index])}`,
          ];
    });
    expect(breaks).toEqual([]);
  },
);
