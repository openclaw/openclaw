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
  const request = (body: Record<string, unknown>) =>
    postChatCompletions(getPort(), {
      model: "openclaw",
      messages: [{ role: "user", content: "hi" }],
      ...body,
    });
  const expectSampling = async (
    body: Record<string, unknown>,
    expected: Partial<AgentStreamParams> | undefined,
  ) => {
    agentCommandMock.mockClear();
    agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "hello" }] } as never);
    const res = await request(body);
    expect(res.status).toBe(200);
    const params = firstAgentCommandOptions()?.streamParams;
    if (expected === undefined) {
      expect(params).toBeUndefined();
    } else {
      expect(params).toMatchObject(expected);
    }
    await res.text();
    return params;
  };
  const expectInvalid = async (body: Record<string, unknown>, field?: string) => {
    agentCommandMock.mockClear();
    const res = await request(body);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: { type?: string; message?: string } };
    expect(json.error?.type).toBe("invalid_request_error");
    if (field) {
      expect(json.error?.message).toMatch(new RegExp(field));
    }
    expect(agentCommandMock).not.toHaveBeenCalled();
  };

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
    await expectSampling({ temperature: 0.3, top_p: 0.95 }, { temperature: 0.3, topP: 0.95 });
    const zero = await expectSampling({ temperature: 0 }, { temperature: 0 });
    expect(zero?.topP).toBeUndefined();
    await expectSampling({}, undefined);
    await expectSampling(
      {
        temperature: null,
        top_p: null,
        frequency_penalty: null,
        presence_penalty: null,
        seed: null,
      },
      undefined,
    );
    await expectInvalid({ temperature: 999 }, "temperature");
    await expectInvalid({ top_p: 5 }, "top_p");
  });

  it("forwards inbound penalty and seed params into streamParams", async () => {
    await expectSampling(
      { frequency_penalty: -0.5, presence_penalty: 1.25, seed: 12345 },
      { frequencyPenalty: -0.5, presencePenalty: 1.25, seed: 12345 },
    );
    for (const body of [{ frequency_penalty: 3 }, { presence_penalty: -3 }, { seed: 1.5 }]) {
      await expectInvalid(body);
    }
  });
}
