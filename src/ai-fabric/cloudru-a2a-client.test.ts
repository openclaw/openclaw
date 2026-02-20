import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudruA2AClient, A2AError } from "./cloudru-a2a-client.js";

// Mock the auth module to avoid real IAM calls
vi.mock("./cloudru-auth.js", () => {
  class MockCloudruTokenProvider {
    async getToken() {
      return { token: "test-iam-token", expiresAt: Date.now() + 3600_000 };
    }
    clearCache() {}
  }

  class MockCloudruAuthError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "CloudruAuthError";
    }
  }

  return {
    CloudruTokenProvider: MockCloudruTokenProvider,
    CloudruAuthError: MockCloudruAuthError,
  };
});

function mockFetch(response: { status: number; body?: unknown }): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    json: () => Promise.resolve(response.body),
    text: () => Promise.resolve(JSON.stringify(response.body ?? {})),
    headers: new Headers(),
  });
}

function mockFetchSequence(
  responses: Array<{ status: number; body?: unknown }>,
): ReturnType<typeof vi.fn> {
  const fn = vi.fn();
  for (const response of responses) {
    fn.mockResolvedValueOnce({
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: () => Promise.resolve(response.body),
      text: () => Promise.resolve(JSON.stringify(response.body ?? {})),
      headers: new Headers(),
    });
  }
  return fn;
}

const AUTH_CONFIG = { keyId: "test-key-id", secret: "test-secret" };
const AGENT_ENDPOINT = "https://agent.cloudru.test/a2a";

describe("CloudruA2AClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends message and returns agent response text", async () => {
    const fetchImpl = mockFetch({
      status: 200,
      body: {
        result: {
          id: "task-1",
          contextId: "sess-1",
          status: {
            state: "completed",
            message: {
              role: "agent",
              parts: [{ kind: "text", text: "Hello from the agent!" }],
            },
          },
        },
      },
    });

    const client = new CloudruA2AClient({
      auth: AUTH_CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.sendMessage({
      endpoint: AGENT_ENDPOINT,
      message: "Hello agent",
    });

    expect(result.ok).toBe(true);
    expect(result.text).toBe("Hello from the agent!");
    expect(result.taskId).toBe("task-1");
    expect(result.sessionId).toBe("sess-1");

    // Verify the request
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(AGENT_ENDPOINT);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-iam-token");

    const body = JSON.parse(init.body as string);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.method).toBe("message/send");
    expect(body.params.message.parts[0].text).toBe("Hello agent");
    expect(body.params.configuration).toEqual({
      acceptedOutputModes: ["text"],
      blocking: true,
    });
  });

  it("includes contextId for multi-turn conversations", async () => {
    const fetchImpl = mockFetch({
      status: 200,
      body: {
        result: {
          id: "task-2",
          contextId: "existing-session",
          status: {
            state: "completed",
            message: { role: "agent", parts: [{ text: "Follow-up" }] },
          },
        },
      },
    });

    const client = new CloudruA2AClient({
      auth: AUTH_CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.sendMessage({
      endpoint: AGENT_ENDPOINT,
      message: "Continue",
      sessionId: "existing-session",
    });

    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.params.contextId).toBe("existing-session");
  });

  it("extracts text from artifacts when status message is empty", async () => {
    const fetchImpl = mockFetch({
      status: 200,
      body: {
        result: {
          id: "task-3",
          status: { state: "completed" },
          artifacts: [
            {
              name: "response",
              parts: [{ text: "Artifact text 1" }, { text: "Artifact text 2" }],
            },
          ],
        },
      },
    });

    const client = new CloudruA2AClient({
      auth: AUTH_CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.sendMessage({
      endpoint: AGENT_ENDPOINT,
      message: "Query",
    });

    expect(result.text).toBe("Artifact text 1\nArtifact text 2");
  });

  it("throws A2AError on HTTP error", async () => {
    const fetchImpl = mockFetch({
      status: 500,
      body: { error: "internal server error" },
    });

    const client = new CloudruA2AClient({
      auth: AUTH_CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.sendMessage({ endpoint: AGENT_ENDPOINT, message: "fail" })).rejects.toThrow(
      A2AError,
    );
  });

  it("throws A2AError on JSON-RPC error response", async () => {
    const fetchImpl = mockFetch({
      status: 200,
      body: {
        error: { code: -32601, message: "Method not found" },
      },
    });

    const client = new CloudruA2AClient({
      auth: AUTH_CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    try {
      await client.sendMessage({ endpoint: AGENT_ENDPOINT, message: "test" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(A2AError);
      expect((err as A2AError).message).toContain("Method not found");
      expect((err as A2AError).code).toBe("-32601");
    }
  });

  it("returns helpful message when agent fails with no text", async () => {
    const fetchImpl = mockFetch({
      status: 200,
      body: {
        result: {
          id: "task-failed",
          status: { state: "failed" },
        },
      },
    });

    const client = new CloudruA2AClient({
      auth: AUTH_CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.sendMessage({
      endpoint: AGENT_ENDPOINT,
      message: "test",
    });

    expect(result.ok).toBe(true);
    expect(result.text).toContain("error");
  });

  it("returns message when agent completes with no text", async () => {
    const fetchImpl = mockFetch({
      status: 200,
      body: {
        result: {
          id: "task-empty",
          status: { state: "completed" },
        },
      },
    });

    const client = new CloudruA2AClient({
      auth: AUTH_CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.sendMessage({
      endpoint: AGENT_ENDPOINT,
      message: "test",
    });

    expect(result.text).toContain("no text response");
  });

  // ---------------------------------------------------------------------------
  // Polling tests (agent-system orchestrators)
  // ---------------------------------------------------------------------------

  describe("polling", () => {
    it("polls working → completed and returns final text", async () => {
      const fetchImpl = mockFetchSequence([
        // 1. message/send returns working
        {
          status: 200,
          body: {
            result: {
              id: "task-poll-1",
              contextId: "sess-poll",
              status: { state: "working" },
            },
          },
        },
        // 2. first tasks/get — still working
        {
          status: 200,
          body: {
            result: {
              id: "task-poll-1",
              contextId: "sess-poll",
              status: { state: "working" },
            },
          },
        },
        // 3. second tasks/get — completed
        {
          status: 200,
          body: {
            result: {
              id: "task-poll-1",
              contextId: "sess-poll",
              status: {
                state: "completed",
                message: {
                  role: "agent",
                  parts: [{ kind: "text", text: "Aggregated results here" }],
                },
              },
            },
          },
        },
      ]);

      const client = new CloudruA2AClient({
        auth: AUTH_CONFIG,
        timeoutMs: 120_000,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      const result = await client.sendMessage({
        endpoint: AGENT_ENDPOINT,
        message: "multi-agent query",
      });

      expect(result.ok).toBe(true);
      expect(result.text).toBe("Aggregated results here");
      expect(result.taskId).toBe("task-poll-1");
      expect(result.sessionId).toBe("sess-poll");
      // 1 send + 2 polls = 3 fetch calls
      expect(fetchImpl).toHaveBeenCalledTimes(3);

      // Verify second call is tasks/get
      const secondBody = JSON.parse(
        (fetchImpl.mock.calls[1] as [string, RequestInit])[1].body as string,
      );
      expect(secondBody.method).toBe("tasks/get");
      expect(secondBody.params.id).toBe("task-poll-1");
    });

    it("throws timeout when polling exceeds deadline", async () => {
      // Always returns working — will exhaust the short timeout
      const fetchImpl = vi.fn().mockImplementation(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              result: {
                id: "task-stuck",
                status: { state: "working" },
              },
            }),
          text: () => Promise.resolve("{}"),
          headers: new Headers(),
        }),
      );

      const client = new CloudruA2AClient({
        auth: AUTH_CONFIG,
        timeoutMs: 1_500, // very short — will time out after 1 poll
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      await expect(
        client.sendMessage({ endpoint: AGENT_ENDPOINT, message: "stuck" }),
      ).rejects.toThrow(/timed out/);
    });

    it("returns error text when poll reaches failed state", async () => {
      const fetchImpl = mockFetchSequence([
        {
          status: 200,
          body: {
            result: {
              id: "task-fail",
              status: { state: "working" },
            },
          },
        },
        {
          status: 200,
          body: {
            result: {
              id: "task-fail",
              status: {
                state: "failed",
                message: {
                  role: "agent",
                  parts: [{ kind: "text", text: "Sub-agent crashed" }],
                },
              },
            },
          },
        },
      ]);

      const client = new CloudruA2AClient({
        auth: AUTH_CONFIG,
        timeoutMs: 30_000,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      const result = await client.sendMessage({
        endpoint: AGENT_ENDPOINT,
        message: "fail scenario",
      });

      expect(result.ok).toBe(true);
      expect(result.text).toBe("Sub-agent crashed");
    });

    it("returns input-required fallback message", async () => {
      const fetchImpl = mockFetchSequence([
        {
          status: 200,
          body: {
            result: {
              id: "task-input",
              status: { state: "working" },
            },
          },
        },
        {
          status: 200,
          body: {
            result: {
              id: "task-input",
              status: { state: "input-required" },
            },
          },
        },
      ]);

      const client = new CloudruA2AClient({
        auth: AUTH_CONFIG,
        timeoutMs: 30_000,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      const result = await client.sendMessage({
        endpoint: AGENT_ENDPOINT,
        message: "needs input",
      });

      expect(result.text).toBe("Agent requires additional input but provided no prompt.");
    });

    it("does not poll when first response is already completed", async () => {
      const fetchImpl = mockFetch({
        status: 200,
        body: {
          result: {
            id: "task-immediate",
            status: {
              state: "completed",
              message: {
                role: "agent",
                parts: [{ kind: "text", text: "Immediate response" }],
              },
            },
          },
        },
      });

      const client = new CloudruA2AClient({
        auth: AUTH_CONFIG,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      const result = await client.sendMessage({
        endpoint: AGENT_ENDPOINT,
        message: "quick query",
      });

      expect(result.text).toBe("Immediate response");
      // Only 1 fetch call — no polling
      expect(fetchImpl).toHaveBeenCalledOnce();
    });
  });
});
