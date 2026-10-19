import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { withFullRuntimeReplyConfig } from "./get-reply-fast-path.js";
import { getReplyFromConfig } from "./get-reply.js";
import { finalizeInboundContext } from "./inbound-context.js";

const preparation = vi.hoisted(() => ({
  hold: undefined as (() => Promise<void>) | undefined,
}));

// Delay the real runtime import, retaining the production admission and queue owners.
vi.mock("./get-reply-run-helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./get-reply-run-helpers.js")>();
  return {
    ...actual,
    loadEmbeddedAgentRuntime: async () => {
      await preparation.hold?.();
      return actual.loadEmbeddedAgentRuntime();
    },
  };
});

// Provider execution is external I/O; cancellation must prevent reaching it.
vi.mock("../../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/embedded-agent.js")>()),
  runEmbeddedAgent: vi.fn(async () => ({
    payloads: [{ text: "Synthetic provider result" }],
    meta: { durationMs: 1 },
  })),
}));

let state: OpenClawTestState | undefined;
afterEach(async () => {
  preparation.hold = undefined;
  await state?.cleanup();
  clearRuntimeConfigSnapshot();
  vi.clearAllMocks();
});

it("preserves a queued successor when interrupt input is canceled during runtime preparation", async () => {
  state = await createOpenClawTestState({
    label: "cancelled-interrupt",
    env: { OPENCLAW_TEST_FAST: "0" },
  });
  const cfg = withFullRuntimeReplyConfig({
    agents: {
      defaults: {
        workspace: state.workspaceDir,
        skipBootstrap: true,
        model: { primary: "mock-openai/gpt-4o" },
        models: { "mock-openai/gpt-4o": { agentRuntime: { id: "openclaw" } } },
      },
    },
    plugins: { enabled: false },
    messages: { queue: { mode: "interrupt" } },
  });
  await state.writeConfig(cfg);
  setRuntimeConfigSnapshot(cfg);

  const sessionKey = "agent:main:dashboard:cancelled-interrupt";
  const admission = {
    sessionKey,
    agentId: "main",
    storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
  };
  const queuedCancellation = new AbortController();
  const enteredPreparation = createDeferred();
  const releasePreparation = createDeferred();
  const enteredBlocker = createDeferred();
  const releaseBlocker = createDeferred();
  const controller = new AbortController();
  preparation.hold = async () => {
    enteredPreparation.resolve();
    await releasePreparation.promise;
  };
  const canceledReply = getReplyFromConfig(
    finalizeInboundContext({
      Provider: "webchat",
      Surface: "webchat",
      ChatType: "direct",
      SessionKey: sessionKey,
      Body: "Replace the earlier request",
    }),
    { abortSignal: controller.signal },
    cfg,
  ).catch((error: unknown) => error);

  let blocker: Promise<void> | undefined;
  let successor: Promise<PromiseSettledResult<string>[]> | undefined;
  try {
    await Promise.race([
      enteredPreparation.promise,
      canceledReply.then((result) => {
        throw new Error("Reply ended before reaching runtime preparation", { cause: result });
      }),
    ]);
    controller.abort(new Error("Input canceled by the user"));
    blocker = withSessionTurn(
      { ...admission, abortSignal: queuedCancellation.signal },
      async () => {
        enteredBlocker.resolve();
        await releaseBlocker.promise;
      },
    );
    await enteredBlocker.promise;
    successor = Promise.allSettled([
      withSessionTurn(
        { ...admission, sessionId: "successor-session", abortSignal: queuedCancellation.signal },
        async () => "successor completed",
      ),
    ]);

    releasePreparation.resolve();
    await canceledReply;
    releaseBlocker.resolve();
    await blocker;
    expect(await successor).toEqual([{ status: "fulfilled", value: "successor completed" }]);
  } finally {
    releasePreparation.resolve();
    releaseBlocker.resolve();
    queuedCancellation.abort(new Error("test cleanup"));
    await Promise.allSettled([canceledReply, blocker, successor]);
  }
});
