import { afterEach, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
import { CHAT_ROUTE_READY_EVENT } from "../chat/chat-history-events.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";

const MODELS_LOADING = "Models are still loading; retry in a moment.";

function modelsLoadingError(details?: { code: string }) {
  return new GatewayRequestError({
    code: "UNAVAILABLE",
    message: MODELS_LOADING,
    retryable: true,
    ...(details ? { details } : {}),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});

it.each([
  {
    details: { code: "MODEL_CATALOG_LOADING" },
    thinkingLevel: "high",
    actions: ["retry", "default-model", "cancel"],
  },
  { details: { code: "MODEL_CATALOG_LOADING" }, thinkingLevel: "", actions: ["retry", "cancel"] },
  { details: undefined, thinkingLevel: "high", actions: ["retry"] },
])(
  "offers $actions for a catalog wait with thinking=$thinkingLevel, then Cancel keeps the draft",
  async ({ details, thinkingLevel, actions }) => {
    const { context, flow, place } = createDraftFixture();
    place.modelControl.thinkingLevel = thinkingLevel;
    vi.mocked(context.sessions.createResult).mockRejectedValueOnce(modelsLoadingError(details));
    flow.setMessage("Review the deployment plan");

    await flow.submit();

    expect({ error: flow.error, errorActions: flow.errorActions }).toEqual({
      error: MODELS_LOADING,
      errorActions: actions,
    });

    flow.clearError();

    expect({
      error: flow.error,
      errorActions: flow.errorActions,
      message: flow.message,
      canSubmit: flow.canSubmit(),
    }).toEqual({
      error: null,
      errorActions: [],
      message: "Review the deployment plan",
      canSubmit: true,
    });
    flow.disconnect();
  },
);

it("starts with the default model by resending the held draft without its model selection", async () => {
  const { context, flow, place } = createDraftFixture();
  place.modelControl.selected = "openai/gpt-5.6-sol";
  place.modelControl.agentRuntime = "codex";
  place.modelControl.contextWindow = "1m";
  place.modelControl.thinkingLevel = "high";
  place.modelControl.fastMode = true;
  vi.spyOn(flow, "canSubmit").mockReturnValue(true);
  vi.mocked(context.sessions.createResult)
    .mockRejectedValueOnce(modelsLoadingError({ code: "MODEL_CATALOG_LOADING" }))
    .mockResolvedValueOnce({ key: "agent:main:default-model", initialRun: { status: "idle" } });
  vi.mocked(context.navigateAndWait).mockImplementation(async () => {
    queueMicrotask(() => document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT)));
  });
  flow.setMessage("Review the deployment plan");

  await flow.submit();
  await flow.submit(undefined, false, "default");

  const [selected, fallback] = vi
    .mocked(context.sessions.createResult)
    .mock.calls.map(([params]) => params);
  expect({ selected, fallback }).toEqual({
    selected: {
      idempotencyKey: expect.any(String),
      agentId: "main",
      message: "Review the deployment plan",
      model: "openai/gpt-5.6-sol",
      agentRuntime: "codex",
      contextWindow: "1m",
      thinkingLevel: "high",
      fastMode: true,
    },
    fallback: {
      idempotencyKey: expect.any(String),
      agentId: "main",
      message: "Review the deployment plan",
      fastMode: true,
    },
  });
  expect({ error: flow.error, message: flow.message, submitting: flow.submitting }).toEqual({
    error: null,
    message: "",
    submitting: false,
  });
  flow.disconnect();
});
