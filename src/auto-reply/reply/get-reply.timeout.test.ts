import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, expect, it, vi } from "vitest";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import { withFullRuntimeReplyConfig } from "./get-reply-fast-path.js";
import { getReplyFromConfig } from "./get-reply.js";
import { finalizeInboundContext } from "./inbound-context.js";

vi.mock("../../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/embedded-agent.js")>()),
  runEmbeddedAgent: vi.fn(async () => ({ payloads: [{ text: "Done" }], meta: { durationMs: 1 } })),
}));

let state: OpenClawTestState | undefined;
afterEach(async () => {
  await state?.cleanup();
  vi.clearAllMocks();
});

it.each([
  { options: { timeoutOverrideMs: 1800000 }, expected: 1800000, expectedOverride: 1800000 },
  { options: { timeoutOverrideMs: 180000 }, expected: 180000, expectedOverride: 180000 },
  { options: { timeoutOverrideMs: 1500 }, expected: 1500, expectedOverride: 1500 },
  {
    options: { timeoutOverrideMs: 0 },
    expected: MAX_TIMER_TIMEOUT_MS,
    expectedOverride: MAX_TIMER_TIMEOUT_MS,
  },
  { options: {}, expected: 180000, expectedOverride: undefined },
  { options: { timeoutOverrideSeconds: 1800 }, expected: 1800000, expectedOverride: 1800000 },
  {
    options: { timeoutOverrideSeconds: 0 },
    expected: MAX_TIMER_TIMEOUT_MS,
    expectedOverride: MAX_TIMER_TIMEOUT_MS,
  },
])(
  "passes timeout options $options to the actual runtime entrypoint",
  async ({ options, expected, expectedOverride }) => {
    state = await createOpenClawTestState({
      label: "reply-timeout",
      env: { OPENCLAW_TEST_FAST: "0" },
    });
    const cfg = withFullRuntimeReplyConfig({
      agents: {
        defaults: {
          workspace: state.workspaceDir,
          skipBootstrap: true,
          timeoutSeconds: 180,
          model: { primary: "mock-openai/gpt-4o" },
          models: { "mock-openai/gpt-4o": { agentRuntime: { id: "openclaw" } } },
        },
      },
      plugins: { enabled: false },
    });
    await state.writeConfig(cfg);
    const reply = await getReplyFromConfig(
      finalizeInboundContext({
        Body: "Review the public documentation",
        Provider: "webchat",
        Surface: "webchat",
        ChatType: "direct",
        SessionKey: "agent:main:dashboard:timeout-proof",
      }),
      options satisfies GetReplyOptions,
      cfg,
    );
    expect([reply].flat()).toEqual([expect.objectContaining({ text: "Done" })]);
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    const run = vi.mocked(runEmbeddedAgent).mock.calls[0]![0];
    expect(run.timeoutMs).toBe(expected);
    expect(run.runTimeoutOverrideMs).toBe(expectedOverride);
  },
);
