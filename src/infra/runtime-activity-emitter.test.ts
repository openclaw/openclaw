import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emitRuntimeReplyActivityLease,
  emitRuntimeTurnActivityLease,
  testing,
} from "./runtime-activity-emitter.js";

const ORIGINAL_ENDPOINT = process.env.OPENCLAW_AGENT_ACTIVITY_ENDPOINT;
const ORIGINAL_BEARER = process.env.OPENCLAW_AGENT_ACTIVITY_BEARER;

function restoreActivityEnv(): void {
  if (ORIGINAL_ENDPOINT === undefined) {
    delete process.env.OPENCLAW_AGENT_ACTIVITY_ENDPOINT;
  } else {
    process.env.OPENCLAW_AGENT_ACTIVITY_ENDPOINT = ORIGINAL_ENDPOINT;
  }
  if (ORIGINAL_BEARER === undefined) {
    delete process.env.OPENCLAW_AGENT_ACTIVITY_BEARER;
  } else {
    process.env.OPENCLAW_AGENT_ACTIVITY_BEARER = ORIGINAL_BEARER;
  }
}

function configureActivityEnv(): void {
  process.env.OPENCLAW_AGENT_ACTIVITY_ENDPOINT =
    "https://command-center.test/api/agents/agent-1/activity";
  process.env.OPENCLAW_AGENT_ACTIVITY_BEARER = "activity-token";
}

function latestFetchJson(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const request = fetchMock.mock.calls.at(-1)?.[1] as { body?: string } | undefined;
  if (!request?.body) {
    throw new Error("Expected activity request body");
  }
  return JSON.parse(request.body) as Record<string, unknown>;
}

afterEach(() => {
  restoreActivityEnv();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("runtime activity emitter", () => {
  it("stays disabled until both endpoint and bearer are configured", () => {
    delete process.env.OPENCLAW_AGENT_ACTIVITY_ENDPOINT;
    delete process.env.OPENCLAW_AGENT_ACTIVITY_BEARER;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    emitRuntimeTurnActivityLease({
      sessionId: "session-1",
      sessionKey: "agent:main:slack:channel:C123",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(testing.endpointConfig()).toBeUndefined();
  });

  it("posts a coarse turn-start lease without message content", () => {
    configureActivityEnv();
    const fetchMock = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    emitRuntimeTurnActivityLease({
      sessionId: "session-1",
      sessionKey: "agent:main:slack:channel:C123:thread:1710000000.000100",
      runId: "run-1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://command-center.test/api/agents/agent-1/activity",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer activity-token",
        "Content-Type": "application/json",
      },
    });
    const body = latestFetchJson(fetchMock);
    expect(body).toMatchObject({
      state: "working",
      currentAction: "Running Slack session",
      actionIcon: "code",
    });
    expect(body.sessions).toMatchObject([
      {
        sessionId: "runtime:agent:main:slack:channel:C123:thread:1710000000.000100",
        kind: "manual",
        status: "running",
        phase: "running",
        currentAction: "Running Slack session",
        actionIcon: "code",
        runId: "run-1",
        threadId: "agent:main:slack:channel:C123:thread:1710000000.000100",
      },
    ]);
    expect(JSON.stringify(body)).not.toContain("secret message");
  });

  it("posts a distinct reply lease keyed by the source session", () => {
    configureActivityEnv();
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetchMock);

    emitRuntimeReplyActivityLease({
      intent: {
        id: "queue-1",
        channel: "slack",
        to: "C123",
        durability: "required",
        renderedBatch: {
          payloads: [{ text: "do not leak this" }],
          plan: {
            payloadCount: 1,
            textCount: 1,
            mediaCount: 0,
            voiceCount: 0,
            presentationCount: 0,
            interactiveCount: 0,
            channelDataCount: 0,
            items: [],
          },
        },
      },
      session: { key: "agent:main:slack:channel:C123" },
    });

    const body = latestFetchJson(fetchMock);
    expect(body).toMatchObject({
      state: "working",
      currentAction: "Replying in Slack",
      actionIcon: "message",
    });
    expect(body.sessions).toMatchObject([
      {
        sessionId: "reply:agent:main:slack:channel:C123",
        phase: "replying",
        currentAction: "Replying in Slack",
        runId: "queue-1",
        threadId: "agent:main:slack:channel:C123",
      },
    ]);
    expect(JSON.stringify(body)).not.toContain("do not leak this");
  });
});
