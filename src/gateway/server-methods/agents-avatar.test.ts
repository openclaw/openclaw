import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { BlobsterUnsupportedRuntimeError } from "../../agents/blobster-generation-errors.js";
import { createLlmOperatorAuthorizationError } from "../../plugins/runtime/runtime-llm-error.js";
import { agentAvatarGenerateHandler } from "./agents-avatar.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";

const generation = vi.hoisted(() => vi.fn());
const capture = vi.hoisted(() => vi.fn());
// mock-isolation: test Gateway admission and responses without model inference.
vi.mock("../../agents/blobster-generation.js", () => ({ generateBlobsterForAgent: generation }));
// mock-isolation: control admitted authority and its cleanup explicitly.
vi.mock("../operator-run-authority.js", () => ({ captureGatewayOperatorRunAuthority: capture }));

const preview = {
  name: "Garden keeper",
  description: "A green Blobster with a watering can.",
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"/>',
};
const cfg = { agents: { defaults: { model: { primary: "ollama/qwen3:4b-instruct" } } } };
const operator = { profileId: "owner" };
const release = vi.fn();

async function generate(
  params: Record<string, unknown>,
  authority: Pick<GatewayRequestHandlerOptions, "hasCurrentClientAuthority" | "signal"> = {},
) {
  const respond = vi.fn();
  await agentAvatarGenerateHandler({
    req: { type: "req", id: "avatar-preview", method: "agents.avatar.generate" },
    params,
    respond,
    context: { getRuntimeConfig: () => cfg } as GatewayRequestContext,
    client: null,
    isWebchatConnect: () => false,
    ...authority,
  });
  return respond;
}

beforeEach(() => {
  generation.mockReset().mockResolvedValue(preview);
  capture.mockReset().mockResolvedValue({ authority: operator, release });
  release.mockReset();
});

describe("agents.avatar.generate", () => {
  it("uses the selected agent and only the submitted description", async () => {
    expect(await generate({ agentId: "garden", prompt: "A gardener" })).toHaveBeenCalledWith(
      true,
      preview,
      undefined,
    );
    expect(generation).toHaveBeenCalledWith({
      cfg,
      agentId: "garden",
      prompt: "A gardener",
      assertCurrent: expect.any(Function),
      operatorAuthority: operator,
      signal: undefined,
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    { label: "missing agent", params: { prompt: "A gardener" } },
    { label: "missing prompt", params: { agentId: "garden" } },
    { label: "empty prompt", params: { agentId: "garden", prompt: "" } },
    { label: "blank prompt", params: { agentId: "garden", prompt: " \n\t" } },
    { label: "oversized prompt", params: { agentId: "garden", prompt: "a".repeat(8_001) } },
    { label: "SOUL context", params: { agentId: "garden", prompt: "A gardener", soul: "private" } },
  ])("rejects $label before model inference", async ({ params }) => {
    expect(await generate(params)).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(capture).not.toHaveBeenCalled();
    expect(generation).not.toHaveBeenCalled();
  });

  it("requires an authenticated operator before model inference", async () => {
    capture.mockResolvedValue(undefined);
    expect(await generate({ agentId: "garden", prompt: "A gardener" })).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    expect(generation).not.toHaveBeenCalled();
  });

  it("does not publish a result after device authority is revoked", async () => {
    const pending = createDeferred<typeof preview>();
    generation.mockReturnValue(pending.promise);
    let current = true;
    const response = generate(
      { agentId: "garden", prompt: "A gardener" },
      { hasCurrentClientAuthority: () => current },
    );
    await vi.waitFor(() => expect(generation).toHaveBeenCalledOnce());
    current = false;
    pending.resolve(preview);
    expect(await response).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: "Avatar generation access changed. Reconnect and try again.",
      }),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("hides invalid provider output", async () => {
    generation.mockResolvedValue({ ...preview, svg: "x".repeat(128_001) });
    expect(await generate({ agentId: "garden", prompt: "A gardener" })).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message:
          "Could not generate a valid Blobster with the selected model. Try a shorter description or another configured model.",
      }),
    );
  });

  it("explains an unsupported runtime without exposing provider details", async () => {
    generation.mockRejectedValue(new BlobsterUnsupportedRuntimeError());
    expect(await generate({ agentId: "garden", prompt: "A gardener" })).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message:
          "The selected agent runtime cannot generate avatars without tools. Choose a supported runtime and try again.",
      }),
    );
  });

  it("returns an actionable authorization error for a disallowed selected model", async () => {
    generation.mockRejectedValue(
      createLlmOperatorAuthorizationError(new Error("Your operator role cannot use this model.")),
    );
    expect(await generate({ agentId: "garden", prompt: "A gardener" })).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "FORBIDDEN",
        message: expect.stringContaining("Choose an allowed model"),
      }),
    );
  });
});
