import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { AnswerLens, ORIGINAL_LENS, type AnswerLensResult } from "./answer-lens.ts";

const source = {
  messageId: "answer-1",
  text: "Original immutable explanation with all the detail.",
};
const plain = { coverage: "condensed", wording: "plain" } as const;
const result = (text: string): AnswerLensResult => ({
  ...plain,
  text,
  messageId: source.messageId,
  sourceRevision: "revision-1",
  model: "fixture/utility",
  durationMs: 150,
});
function setup() {
  const request = vi.fn<GatewayBrowserClient["request"]>();
  const owner = new AnswerLens();
  const client = { request };
  owner.configure({ client, epoch: 1, sessionKey: "agent:test:lens", agentId: "test" });
  return { owner, request, client };
}

describe("Answer Lens presentation ownership", () => {
  it("always starts from canonical source and restores original without model work", async () => {
    const { owner, request } = setup();
    request.mockResolvedValueOnce({ ...result(source.text), ...ORIGINAL_LENS });
    request.mockResolvedValueOnce(result("Simplified explanation."));
    await owner.select(source, plain);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "chat.answer.transform",
      "chat.answer.transform",
    ]);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      ...ORIGINAL_LENS,
      messageId: source.messageId,
    });
    expect(request.mock.calls[1]?.[1]).toMatchObject({ ...plain, sourceRevision: "revision-1" });
    expect(request.mock.calls[1]?.[1]).not.toHaveProperty("text");
    expect(owner.read(source)?.displayed?.text).toBe("Simplified explanation.");
    await owner.select(source, ORIGINAL_LENS);
    expect(owner.read(source)?.displayed).toBeUndefined();
    await owner.select(source, plain);
    expect(owner.read(source)?.cached).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    expect(source.text).toBe("Original immutable explanation with all the detail.");
  });

  it("rejects late results after reset and explicitly cancels only its request", async () => {
    const { owner, request } = setup();
    const delayed = Promise.withResolvers<AnswerLensResult>();
    request
      .mockResolvedValueOnce(result(source.text))
      .mockReturnValueOnce(delayed.promise)
      .mockResolvedValue({});
    const selecting = owner.select(source, plain);
    await Promise.resolve();
    const requestId = owner.read(source)?.pending?.requestId;
    await owner.select(source, ORIGINAL_LENS);
    delayed.resolve(result("Too late"));
    await selecting;
    expect(owner.read(source)?.displayed).toBeUndefined();
    expect(request).toHaveBeenCalledWith("chat.answer.cancel", { requestId });
  });

  it("does not publish old-session results or reuse cache across connection epochs", async () => {
    const { owner, request, client } = setup();
    const delayed = Promise.withResolvers<AnswerLensResult>();
    request.mockReturnValueOnce(delayed.promise).mockResolvedValue({});
    const selecting = owner.select(source, plain);
    owner.configure({ client, epoch: 2, sessionKey: "agent:test:other", agentId: "test" });
    delayed.resolve(result("Wrong session"));
    await selecting;
    expect(owner.read(source)).toBeUndefined();
    expect(
      request.mock.calls.filter(([method]) => method === "chat.answer.transform"),
    ).toHaveLength(1);
  });

  it("keeps the last explanation on failure and never exposes it for edited source", async () => {
    const { owner, request } = setup();
    request
      .mockResolvedValueOnce(result(source.text))
      .mockResolvedValueOnce(result("Good variant"));
    await owner.select(source, plain);
    request.mockRejectedValueOnce(new Error("Utility unavailable"));
    await owner.select(source, { coverage: "gist", wording: "clearer" });
    expect(owner.read(source)?.displayed?.text).toBe("Good variant");
    expect(owner.read(source)?.error).toContain("Utility unavailable");
    expect(owner.read({ ...source, text: "Edited" })).toBeUndefined();
  });
  it("invalidates visited settings when the pane observes a configuration or sharing change", async () => {
    const { owner, request, client } = setup();
    request.mockResolvedValueOnce(result(source.text)).mockResolvedValueOnce(result("Old model"));
    await owner.select(source, plain);
    owner.configure({
      client,
      epoch: 1,
      policyEpoch: 1,
      sessionKey: "agent:test:lens",
      agentId: "test",
    });
    expect(owner.read(source)).toBeUndefined();
    request
      .mockResolvedValueOnce(result(source.text))
      .mockResolvedValueOnce({ ...result("New model"), model: "fixture/new" });
    await owner.select(source, plain);
    expect(request).toHaveBeenCalledTimes(4);
    expect(owner.read(source)?.displayed?.model).toBe("fixture/new");
  });

  it("drops a stale baseline and resolves canonical source again on explicit retry", async () => {
    const { owner, request } = setup();
    request
      .mockResolvedValueOnce(result(source.text))
      .mockResolvedValueOnce(result("Good variant"));
    await owner.select(source, plain);
    request.mockRejectedValueOnce(
      new GatewayProtocolRequestError({
        code: "INVALID_REQUEST",
        message: "Source changed",
        details: { code: "ANSWER_LENS_SOURCE_CHANGED" },
      }),
    );
    const target = { coverage: "gist", wording: "plain" } as const;
    await owner.select(source, target);
    expect(owner.read(source)?.baseline).toBeUndefined();
    expect(owner.read(source)?.displayed).toBeUndefined();
    expect(owner.read(source)?.variants.size).toBe(0);
    request
      .mockResolvedValueOnce({ ...result(source.text), sourceRevision: "rev-2" })
      .mockResolvedValueOnce({ ...result("Fresh variant"), sourceRevision: "rev-2" });
    await owner.select(source, target);
    expect(request.mock.calls[3]?.[1]).toMatchObject(ORIGINAL_LENS);
    expect(request.mock.calls[4]?.[1]).toMatchObject({ sourceRevision: "rev-2" });
  });
});

it("shows request-scoped partial text without caching it and rolls it back on failure", async () => {
  const { owner, request } = setup();
  let receive: Parameters<GatewayBrowserClient["addEventListener"]>[0] = () => {};
  const detach = vi.fn();
  owner.configure({
    client: {
      request,
      addEventListener: (listener) => {
        receive = listener;
        return detach;
      },
    },
    sessionKey: "agent:test:lens",
  });
  request.mockResolvedValueOnce(result(source.text)).mockResolvedValueOnce(result("Good variant"));
  await owner.select(source, plain);
  const delayed = Promise.withResolvers<AnswerLensResult>();
  request.mockReturnValueOnce(delayed.promise);
  const target = { coverage: "gist", wording: "clearer" } as const;
  const selecting = owner.select(source, target);
  const requestId = owner.read(source)!.pending!.requestId;
  const partial = (id: string, text: string) =>
    receive({
      type: "event",
      event: "chat.answer.delta",
      payload: {
        ...result(text),
        ...target,
        requestId: id,
      },
    });
  partial("other-request", "Wrong answer");
  expect(owner.read(source)?.partialText).toBeUndefined();
  partial(requestId, "New text arriving");
  expect(owner.read(source)?.partialText).toBe("New text arriving");
  expect(owner.read(source)?.variants.size).toBe(1);
  delayed.reject(new Error("Interrupted"));
  await selecting;
  expect(owner.read(source)?.partialText).toBeUndefined();
  expect(owner.read(source)?.displayed?.text).toBe("Good variant");
  partial(requestId, "Late text");
  expect(owner.read(source)?.partialText).toBeUndefined();
  expect(detach).toHaveBeenCalledTimes(2);
});
