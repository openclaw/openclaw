import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runNodeScript } from "../../../test/helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { BlobsterUnsupportedRuntimeError } from "../../agents/blobster-generation-errors.js";
import { createLlmOperatorAuthorizationError } from "../../plugins/runtime/runtime-llm-error.js";
import { agentAvatarGenerateHandler } from "./agents-avatar.js";
import { callAgentHandler } from "./agents-mutate.test-support.js";
import type { GatewayRequestContext } from "./types.js";

const { generation, capture } = vi.hoisted(() => ({ generation: vi.fn(), capture: vi.fn() }));
// mock-isolation: test Gateway admission and responses without model inference.
vi.mock("../../agents/blobster-generation.js", () => ({ generateBlobsterForAgent: generation }));
// mock-isolation: control admitted authority and its cleanup explicitly.
vi.mock("../operator-run-authority.js", () => ({ captureGatewayOperatorRunAuthority: capture }));

const preview = {
  name: "Garden keeper",
  description: "A green Blobster with a watering can.",
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"/>',
};
const operator = { profileId: "owner" };
const release = vi.fn();
let current = true;
const dirs = useAutoCleanupTempDirTracker(afterEach);

function generate(params: Record<string, unknown> = { agentId: "garden", prompt: "A gardener" }) {
  return callAgentHandler(agentAvatarGenerateHandler, "agents.avatar.generate", params, {
    context: { getRuntimeConfig: () => ({}) } as GatewayRequestContext,
    hasCurrentClientAuthority: () => current,
  });
}

function expectError(
  respond: ReturnType<typeof vi.fn>,
  error: { code: string; message?: unknown },
) {
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining(error));
}

beforeEach(() => {
  current = true;
  generation.mockReset().mockResolvedValue(preview);
  capture.mockReset().mockResolvedValue({ authority: operator, release });
  release.mockReset();
});

it("registers avatar generation without loading its parser", async () => {
  const result = await runNodeScript(
    [
      "--import",
      fileURLToPath(new URL("../../../scripts/tsx.mjs", import.meta.url)),
      "--input-type=module",
      "--eval",
      `import assert from "node:assert/strict";
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "parse5") throw new Error("Agents RPC registration loaded the avatar parser");
  return nextResolve(specifier, context);
} });
const { agentAvatarGenerateHandler } = await import(${JSON.stringify(new URL("./agents-avatar.ts", import.meta.url).href)});
assert.equal(typeof agentAvatarGenerateHandler, "function");
console.log("avatar-handler-import-ok");`,
    ],
    {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: dirs.make("agents-import-"),
    },
    30_000,
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("avatar-handler-import-ok");
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

it.each([
  [
    "revoked device",
    () =>
      generation.mockImplementation(async () => {
        current = false;
        return preview;
      }),
    "UNAVAILABLE",
    "Avatar generation access changed. Reconnect and try again.",
  ],
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
    expect(generation.mock.lastCall?.[0]).toMatchObject({
      agentId: "garden",
      prompt: "A gardener",
    });
    expect(release).toHaveBeenCalledOnce();
  },
);
