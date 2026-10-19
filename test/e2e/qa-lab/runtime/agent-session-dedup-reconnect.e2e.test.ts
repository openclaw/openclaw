import { afterEach, describe, expect, it, onTestFailed, vi } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import {
  connectOperator,
  messageRole,
  messageText,
  runCleanups,
  startSessionGateway,
} from "./agent-session.test-support.js";
import { MODEL_REF } from "./cloud-worker-midturn-loss-fixture.js";
import { startHeldResponsesProvider } from "./held-responses-provider.js";

const TEST_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 20_000;
const SESSION_KEY = "agent:qa:qa:session-dedup-reconnect";
const IDEMPOTENCY_KEY = "qa-session-dedup-reconnect";
const ORIGINAL_MESSAGE = "Return exactly SESSION-DEDUP-RECONNECT-OK.";
const CHANGED_MESSAGE = "This changed replay must not create another turn.";
const TERMINAL_TEXT = "SESSION-DEDUP-RECONNECT-OK";

type AgentResult = {
  runId?: string;
  status?: string;
  result?: {
    payloads?: Array<{ text?: string }>;
  };
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(() => runCleanups(cleanups, "agent-session-dedup-reconnect cleanup failed"));

describe("agent session deduplication across reconnect", () => {
  it(
    "replays one accepted run and one terminal transcript without a second provider call",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const provider = await startHeldResponsesProvider({
        modelRef: MODEL_REF,
        terminalText: TERMINAL_TEXT,
      });
      cleanups.push(() => provider.stop());
      const gatewayOwner = createQaGatewayChild();
      cleanups.push(() => stopQaGatewayFixture(gatewayOwner));
      const gateway = await startSessionGateway(gatewayOwner, provider.baseUrl);
      onTestFailed(() => {
        process.stderr.write(gateway.logs().slice(-12_000));
      });
      cleanups.push(async () => provider.release());
      const clientA = await connectOperator(gateway, "Session dedup client A");
      cleanups.push(() => clientA.stopAndWait({ timeoutMs: 1_000 }));
      const acceptedA = await clientA.request<AgentResult>("agent", {
        sessionKey: SESSION_KEY,
        message: ORIGINAL_MESSAGE,
        deliver: false,
        idempotencyKey: IDEMPOTENCY_KEY,
      });
      expect(acceptedA).toMatchObject({
        status: "accepted",
        runId: IDEMPOTENCY_KEY,
      });
      await vi.waitFor(() => expect(provider.requests).toHaveLength(1), {
        interval: 20,
        timeout: REQUEST_TIMEOUT_MS,
      });
      await clientA.stopAndWait({ timeoutMs: 1_000 });

      const clientB = await connectOperator(gateway, "Session dedup client B");
      cleanups.push(() => clientB.stopAndWait({ timeoutMs: 1_000 }));
      const acceptedB = await clientB.request<AgentResult>("agent", {
        sessionKey: SESSION_KEY,
        message: ORIGINAL_MESSAGE,
        deliver: false,
        idempotencyKey: IDEMPOTENCY_KEY,
      });
      expect(acceptedB).toMatchObject({
        status: "in_flight",
        runId: acceptedA.runId,
        sessionKey: SESSION_KEY,
      });
      expect(provider.requests).toHaveLength(1);

      provider.release();
      const terminal = await clientB.request<AgentResult>(
        "agent.wait",
        { runId: IDEMPOTENCY_KEY, timeoutMs: 30_000 },
        { timeoutMs: 35_000 },
      );
      expect(terminal).toMatchObject({
        status: "ok",
        runId: IDEMPOTENCY_KEY,
      });

      const cachedTerminal = await clientB.request<AgentResult>("agent", {
        sessionKey: SESSION_KEY,
        message: ORIGINAL_MESSAGE,
        deliver: false,
        idempotencyKey: IDEMPOTENCY_KEY,
      });
      expect(cachedTerminal).toMatchObject({
        status: terminal.status,
        runId: terminal.runId,
        result: {
          payloads: [{ text: TERMINAL_TEXT }],
        },
      });
      const changedReplay = await clientB.request<AgentResult>("agent", {
        sessionKey: SESSION_KEY,
        message: CHANGED_MESSAGE,
        deliver: false,
        idempotencyKey: IDEMPOTENCY_KEY,
      });
      expect(changedReplay).toEqual(cachedTerminal);
      expect(provider.requests).toHaveLength(1);

      const history = await clientB.request<{ messages?: unknown[] }>("chat.history", {
        sessionKey: SESSION_KEY,
        limit: 20,
      });
      const turns = (history.messages ?? []).filter((message) =>
        ["user", "assistant"].includes(messageRole(message) ?? ""),
      );
      expect(turns.map(messageRole)).toEqual(["user", "assistant"]);
      expect(messageText(turns[0])).toContain(ORIGINAL_MESSAGE);
      expect(messageText(turns[0])).not.toContain(CHANGED_MESSAGE);
      expect(messageText(turns[1])).toContain(TERMINAL_TEXT);
      expect(JSON.stringify(provider.requests[0])).toContain(ORIGINAL_MESSAGE);
      expect(JSON.stringify(provider.requests[0])).not.toContain(CHANGED_MESSAGE);
    },
  );
});
