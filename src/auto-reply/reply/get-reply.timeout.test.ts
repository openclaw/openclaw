import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, expect, it, vi } from "vitest";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import { withFullRuntimeReplyConfig } from "./get-reply-fast-path.js";
import { getReplyFromConfigInternal } from "./get-reply.js";
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

async function runReply(
  ctx: Parameters<typeof finalizeInboundContext>[0],
  options?: GetReplyOptions,
) {
  state = await createOpenClawTestState({
    label: "reply-runtime",
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
    commands: { text: true },
  });
  await state.writeConfig(cfg);
  const reply = await getReplyFromConfigInternal(
    finalizeInboundContext({
      Provider: "webchat",
      Surface: "webchat",
      ChatType: "direct",
      SessionKey: "agent:main:dashboard:runtime-proof",
      ...ctx,
    }),
    options,
    cfg,
  );
  expect([reply].flat()).toEqual([expect.objectContaining({ text: "Done" })]);
  expect(runEmbeddedAgent).toHaveBeenCalledOnce();
  return vi.mocked(runEmbeddedAgent).mock.calls[0]![0];
}

it.each([
  [{ timeoutOverrideMs: 1500 }, 1500, 1500],
  [{ timeoutOverrideSeconds: 0 }, MAX_TIMER_TIMEOUT_MS, MAX_TIMER_TIMEOUT_MS],
  [{}, 180000, undefined],
])(
  "passes timeout options %s to the actual runtime entrypoint",
  async (options, expected, override) => {
    const run = await runReply({ Body: "Review the public documentation" }, options);
    expect(run.timeoutMs).toBe(expected);
    expect(run.runTimeoutOverrideMs).toBe(override);
  },
);

it("runs the task following a text exec policy", async () => {
  const body = "/exec security=deny ask=always Explain the output.";
  const run = await runReply({
    Body: body,
    RawBody: body,
    BodyForAgent: body,
    CommandBody: body,
    CommandSource: "text",
    CommandAuthorized: true,
  });
  expect(run.prompt).toContain("Explain the output.");
  expect(run.prompt).not.toContain("/exec");
  expect(run.execOverrides).toMatchObject({ security: "deny", ask: "always" });
});
