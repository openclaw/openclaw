/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createComposerContainer,
  createComposerProps,
  disposeComposer,
  renderComposerInto,
  resetComposerFixture,
} from "./chat-composer.test-support.ts";

afterEach(() => resetComposerFixture());
const suggestion = "Show me the smaller implementation first.";

function fixture(
  response: Promise<{ text: string | null }> = Promise.resolve({ text: suggestion }),
) {
  let listener: ((event: GatewayEventFrame) => void) | undefined;
  let draft = "";
  const request = vi.fn((method: string, _params?: unknown, _options?: { signal?: AbortSignal }) =>
    method === "chat.predict" ? response : Promise.resolve({}),
  );
  // SAFETY: This composer fixture exercises only the typed prediction request.
  const client = { request } as unknown as GatewayBrowserClient;
  const props = createComposerProps({
    currentSessionId: "session-a",
    gatewayClient: client,
    composerPredictions: {
      enabled: true,
      active: true,
      gateway: {
        subscribeEvents: (next) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
      },
    },
    getDraft: () => draft,
    onDraftChange: (next) => {
      draft = next;
      props.draft = next;
    },
  });
  const container = document.body.appendChild(createComposerContainer());
  const paint = () => renderComposerInto(container, props);
  paint();
  const input = container.querySelector("textarea")!;
  const prediction = () => container.querySelector(".agent-chat__composer-prediction");
  const finish = (runId = "run-a") =>
    listener?.({
      type: "event",
      event: "chat",
      payload: { sessionKey: "main", runId, state: "final" },
    });
  return {
    props,
    container,
    input,
    request,
    paint,
    finish,
    prediction,
    show: async () => {
      finish();
      await waitForSolid(() => expect(prediction()?.textContent).toBe(suggestion));
    },
    key: (key: string) =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })),
    edit: (text: string) => {
      input.value = text;
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    },
    draft: () => draft,
    predictions: () => request.mock.calls.filter(([method]) => method === "chat.predict"),
  };
}

type Fixture = ReturnType<typeof fixture>;
const changes = {
  disabled: (f) => Object.assign(f.props.composerPredictions!, { enabled: false }),
  hidden: (f) => Object.assign(f.props.composerPredictions!, { active: false }),
  "read-only": (f) => Object.assign(f.props, { canSend: false }),
  draft: (f) => f.edit("Existing draft"),
  attachment: (f) => Object.assign(f.props, { getPendingAttachmentReads: () => 1 }),
  session: (f) => Object.assign(f.props, { currentSessionId: "session-b" }),
  client: (f) => {
    f.props.gatewayClient = { request: vi.fn() } as unknown as GatewayBrowserClient;
  },
  run: (f) => Object.assign(f.props, { runActive: true }),
} satisfies Record<string, (f: Fixture) => void>;

it("shows a prediction without changing the draft; Tab accepts but never sends", async () => {
  const f = fixture();
  await f.show();
  expect(f.input.value).toBe("");
  expect(f.draft()).toBe("");
  f.key("Enter");
  expect(f.props.onSend).not.toHaveBeenCalled();
  f.key("Tab");
  expect(f.input.value).toBe(suggestion);
  expect(f.draft()).toBe(suggestion);
  expect(f.props.onSend).not.toHaveBeenCalled();
  flush();
  expect(f.prediction()).toBeNull();
  f.finish();
  expect(f.predictions()).toHaveLength(1);
});

it.each(["Escape", "typing"])("dismisses with %s without accepting", async (action) => {
  const f = fixture();
  await f.show();
  if (action === "Escape") {
    f.key("Escape");
  } else {
    f.edit("My own question");
  }
  flush();
  expect(f.prediction()).toBeNull();
  expect(f.input.value).toBe(action === "typing" ? "My own question" : "");
  expect(f.props.onSend).not.toHaveBeenCalled();
});

it.each(["disabled", "hidden", "read-only", "draft", "attachment"] as const)(
  "does not predict in a %s composer",
  async (kind) => {
    const f = fixture();
    changes[kind](f);
    f.paint();
    f.finish();
    await Promise.resolve();
    expect(f.predictions()).toHaveLength(0);
  },
);

it.each(["session", "client", "draft", "disabled", "run"] as const)(
  "drops an in-flight result after %s changes",
  async (kind) => {
    const response = createDeferred<{ text: string | null }>();
    const f = fixture(response.promise);
    f.finish();
    expect(f.predictions()).toHaveLength(1);
    changes[kind](f);
    f.paint();
    response.resolve({ text: suggestion });
    await Promise.resolve();
    flush();
    expect(f.prediction()).toBeNull();
  },
);

it("waits for completion to become idle and accepts using the touch control", async () => {
  const f = fixture();
  f.props.runActive = true;
  f.paint();
  f.finish();
  expect(f.predictions()).toHaveLength(0);
  f.props.runActive = false;
  f.paint();
  await waitForSolid(() => expect(f.prediction()).not.toBeNull());
  const button = [...f.container.querySelectorAll("button")].find((node) =>
    node.textContent?.includes("Use suggestion"),
  )!;
  button.click();
  expect(f.draft()).toBe(suggestion);
  expect(f.props.onSend).not.toHaveBeenCalled();
});

it("discards a displayed suggestion when another run starts before its first delta", async () => {
  const f = fixture();
  await f.show();
  f.props.runActive = true;
  f.paint();
  expect(f.prediction()).toBeNull();
  f.key("Tab");
  expect(f.draft()).toBe("");
  expect(f.props.onSend).not.toHaveBeenCalled();
});

it("retires the event subscription and pending prediction when the composer unmounts", async () => {
  const response = createDeferred<{ text: string | null }>();
  const f = fixture(response.promise);
  f.finish();
  const signal = f.predictions()[0]?.[2]?.signal;
  expect(signal?.aborted).toBe(false);
  disposeComposer(f.container);
  expect(signal?.aborted).toBe(true);
  f.finish("run-b");
  expect(f.predictions()).toHaveLength(1);
  response.resolve({ text: suggestion });
  await Promise.resolve();
  flush();
  expect(f.prediction()).toBeNull();
});
