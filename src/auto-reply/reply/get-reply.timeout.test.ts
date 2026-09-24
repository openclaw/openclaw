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
  [{ timeoutOverrideMs: 1800000 }, 1800000, 1800000],
  [{ timeoutOverrideMs: 180000 }, 180000, 180000],
  [{ timeoutOverrideMs: 1500 }, 1500, 1500],
  [{ timeoutOverrideMs: 0 }, MAX_TIMER_TIMEOUT_MS, MAX_TIMER_TIMEOUT_MS],
  [{}, 180000, undefined],
  [{ timeoutOverrideSeconds: 1800 }, 1800000, 1800000],
  [{ timeoutOverrideSeconds: 0 }, MAX_TIMER_TIMEOUT_MS, MAX_TIMER_TIMEOUT_MS],
])(
  "passes timeout options %s to the actual runtime entrypoint",
  async (options, expected, expectedOverride) => {
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
