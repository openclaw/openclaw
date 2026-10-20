import { beforeEach, expect, it, vi } from "vitest";
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
  params: Record<string, unknown> = { agentId: "garden", prompt: "A gardener" },
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

function expectError(
  respond: ReturnType<typeof vi.fn>,
  error: { code: string; message?: unknown },
) {
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining(error));
}

beforeEach(() => {
  generation.mockReset().mockResolvedValue(preview);
  capture.mockReset().mockResolvedValue({ authority: operator, release });
  release.mockReset();
});

it("uses the selected agent and only the submitted description", async () => {
  expect(await generate()).toHaveBeenCalledWith(true, preview, undefined);
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
  expectError(await generate(params), { code: "INVALID_REQUEST" });
  expect(capture).not.toHaveBeenCalled();
  expect(generation).not.toHaveBeenCalled();
});

it("requires an authenticated operator before model inference", async () => {
  capture.mockResolvedValue(undefined);
  expectError(await generate(), { code: "FORBIDDEN" });
  expect(generation).not.toHaveBeenCalled();
});

it("does not publish a result after device authority is revoked", async () => {
  const pending = createDeferred<typeof preview>();
  generation.mockReturnValue(pending.promise);
  let current = true;
  const response = generate(undefined, { hasCurrentClientAuthority: () => current });
  await vi.waitFor(() => expect(generation).toHaveBeenCalledOnce());
  current = false;
  pending.resolve(preview);
  expectError(await response, {
    code: "UNAVAILABLE",
    message: "Avatar generation access changed. Reconnect and try again.",
  });
  expect(release).toHaveBeenCalledOnce();
});

it.each([
  [
    "invalid provider output",
    () => generation.mockResolvedValue({ ...preview, svg: "x".repeat(128_001) }),
    "UNAVAILABLE",
    "Could not generate a valid Blobster with the selected model. Try a shorter description or another configured model.",
  ],
  [
    "unsupported runtime",
    () => generation.mockRejectedValue(new BlobsterUnsupportedRuntimeError()),
    "UNAVAILABLE",
    "The selected agent runtime cannot generate avatars without tools. Choose a supported runtime and try again.",
  ],
  [
    "disallowed selected model",
    () => generation.mockRejectedValue(createLlmOperatorAuthorizationError(new Error("Denied"))),
    "FORBIDDEN",
    expect.stringContaining("Choose an allowed model"),
  ],
] as const)(
  "handles %s without exposing provider details",
  async (_label, prepare, code, message) => {
    prepare();
    expectError(await generate(), { code, message });
  },
);
