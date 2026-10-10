import { expect, it } from "vitest";
import type { AgentStreamParams } from "../agents/command/shared-types.js";
import type { agentCommandMock as sharedAgentCommandMock } from "./test-helpers.runtime-state.js";

export function registerOpenAiHttpSamplingTests({
  getPort,
  postChatCompletions,
  postRawChatCompletions,
  firstAgentCommandOptions,
  agentCommandMock,
}: {
  getPort: () => number;
  postChatCompletions: (port: number, body: unknown) => Promise<Response>;
  postRawChatCompletions: (port: number, body: string) => Promise<Response>;
  firstAgentCommandOptions: () => { streamParams?: AgentStreamParams } | undefined;
  agentCommandMock: typeof sharedAgentCommandMock;
}): void {
  const mockAgentOnce = (payloads: Array<{ text: string }>) => {
    agentCommandMock.mockClear();
    agentCommandMock.mockResolvedValueOnce({ payloads } as never);
  };
  const getStreamParams = () => firstAgentCommandOptions()?.streamParams;

  it("rejects malformed sampling numbers before agent dispatch", async () => {
    for (const field of ["temperature", "top_p", "frequency_penalty", "presence_penalty", "seed"]) {
      for (const [raw, received] of [
        ['"0.5"', "string"],
        ["1e309", "Infinity"],
        ["-1e309", "-Infinity"],
      ]) {
        agentCommandMock.mockClear();
        const res = await postRawChatCompletions(
          getPort(),
          `{"model":"openclaw","messages":[{"role":"user","content":"hi"}],"${field}":${raw}}`,
        );
        expect(res.status, `${field}: ${raw}`).toBe(400);
        await expect(res.json()).resolves.toEqual({
          error: {
            message: `${field}: Invalid input: expected number, received ${received}`,
            type: "invalid_request_error",
          },
        });
        expect(agentCommandMock, `${field}: ${raw}`).not.toHaveBeenCalled();
      }
    }
  });

  it("forwards inbound temperature and top_p into streamParams", async () => {
    const port = getPort();

    {
      mockAgentOnce([{ text: "hello" }]);
      const res = await postChatCompletions(port, {
        model: "openclaw",
        temperature: 0.3,
        top_p: 0.95,
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.status).toBe(200);
      expect(getStreamParams()).toMatchObject({ temperature: 0.3, topP: 0.95 });
      await res.text();
    }

    {
      mockAgentOnce([{ text: "hello" }]);
      const res = await postChatCompletions(port, {
        model: "openclaw",
        temperature: 0,
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.status).toBe(200);
      const params = getStreamParams();
      expect(params?.temperature).toBe(0);
      expect(params?.topP).toBeUndefined();
      await res.text();
    }

    {
      mockAgentOnce([{ text: "hello" }]);
      const res = await postChatCompletions(port, {
        model: "openclaw",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.status).toBe(200);
      expect(getStreamParams()).toBeUndefined();
      await res.text();
    }

    {
      mockAgentOnce([{ text: "hello" }]);
      const res = await postChatCompletions(port, {
        model: "openclaw",
        temperature: null,
        top_p: null,
        frequency_penalty: null,
        presence_penalty: null,
        seed: null,
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.status).toBe(200);
      expect(getStreamParams()).toBeUndefined();
      await res.text();
    }

    {
      agentCommandMock.mockClear();
      const res = await postChatCompletions(port, {
        model: "openclaw",
        temperature: 999,
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error?: { type?: string; message?: string } };
      expect(json.error?.type).toBe("invalid_request_error");
      expect(json.error?.message).toMatch(/temperature/);
      expect(agentCommandMock).toHaveBeenCalledTimes(0);
    }

    {
      agentCommandMock.mockClear();
      const res = await postChatCompletions(port, {
        model: "openclaw",
        top_p: 5,
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error?: { type?: string; message?: string } };
      expect(json.error?.type).toBe("invalid_request_error");
      expect(json.error?.message).toMatch(/top_p/);
      expect(agentCommandMock).toHaveBeenCalledTimes(0);
    }
  });

  it("forwards inbound penalty and seed params into streamParams", async () => {
    const port = getPort();

    {
      mockAgentOnce([{ text: "hello" }]);
      const res = await postChatCompletions(port, {
        model: "openclaw",
        frequency_penalty: -0.5,
        presence_penalty: 1.25,
        seed: 12345,
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.status).toBe(200);
      expect(getStreamParams()).toMatchObject({
        frequencyPenalty: -0.5,
        presencePenalty: 1.25,
        seed: 12345,
      });
      await res.text();
    }

    for (const body of [{ frequency_penalty: 3 }, { presence_penalty: -3 }, { seed: 1.5 }]) {
      agentCommandMock.mockClear();
      const res = await postChatCompletions(port, {
        model: "openclaw",
        ...body,
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error?: { type?: string; message?: string } };
      expect(json.error?.type).toBe("invalid_request_error");
      expect(agentCommandMock).toHaveBeenCalledTimes(0);
    }
  });
}
