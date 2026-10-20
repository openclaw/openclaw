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

function fixture({ pending = false, runActive = false } = {}) {
  const response = createDeferred<{ text: string | null }>();
  let listener: ((event: GatewayEventFrame) => void) | undefined;
  const subscribeEvents = (next: (event: GatewayEventFrame) => void) => {
    listener = next;
    return () => {
      listener = undefined;
    };
  };
  let draft = "";
  const request = vi.fn((method: string, _params?: unknown, _options?: { signal?: AbortSignal }) =>
    method === "chat.predict"
      ? pending
        ? response.promise
        : Promise.resolve({ text: suggestion })
      : Promise.resolve({}),
  );
  const props = createComposerProps({
    runActive,
    currentSessionId: "session-a",
    // SAFETY: This composer fixture exercises only the typed prediction request.
    gatewayClient: { request } as unknown as GatewayBrowserClient,
    composerPredictions: { enabled: true, active: true, gateway: { subscribeEvents } },
    getDraft: () => draft,
    onDraftChange: (next) => {
      draft = next;
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
  if (pending) {
    finish();
  }
  return {
    props,
    container,
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
    expectDraft: (value: string) => {
      expect({ input: input.value, draft }).toEqual({ input: value, draft: value });
      expect(props.onSend).not.toHaveBeenCalled();
    },
    predictions: () => request.mock.calls.filter(([method]) => method === "chat.predict"),
    settle: async () => {
      response.resolve({ text: suggestion });
      await Promise.resolve();
      flush();
    },
  };
}

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
} satisfies Record<string, (f: ReturnType<typeof fixture>) => void>;

it.each(["Tab", "touch"])("accepts with %s only when idle, without sending", async (control) => {
  const f = fixture({ runActive: control === "touch" });
  f.finish();
  if (control === "touch") {
    expect(f.predictions()).toHaveLength(0);
    f.props.runActive = false;
    f.paint();
  }
  await waitForSolid(() => expect(f.prediction()?.textContent).toBe(suggestion));
  f.expectDraft("");
  f.key("Enter");
  expect(f.props.onSend).not.toHaveBeenCalled();
  if (control === "Tab") {
    f.key("Tab");
  } else {
    f.container.querySelector<HTMLButtonElement>('[aria-label="Use suggestion"]')!.click();
  }
  f.expectDraft(suggestion);
  flush();
  expect(f.prediction()).toBeNull();
  f.finish();
  expect(f.predictions()).toHaveLength(1);
});

it.each(["Escape", "typing", "new run"])("dismisses with %s without accepting", async (action) => {
  const f = fixture();
  await f.show();
  if (action === "Escape") {
    f.key("Escape");
  } else if (action === "typing") {
    f.edit("My own question");
  } else {
    changes.run(f);
    f.paint();
    expect(f.prediction()).toBeNull();
    f.key("Tab");
  }
  flush();
  expect(f.prediction()).toBeNull();
  f.expectDraft(action === "typing" ? "My own question" : "");
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
    const f = fixture({ pending: true });
    expect(f.predictions()).toHaveLength(1);
    changes[kind](f);
    f.paint();
    await f.settle();
    expect(f.prediction()).toBeNull();
  },
);

it("retires the event subscription and pending prediction when the composer unmounts", async () => {
  const f = fixture({ pending: true });
  const signal = f.predictions()[0]?.[2]?.signal;
  expect(signal?.aborted).toBe(false);
  disposeComposer(f.container);
  expect(signal?.aborted).toBe(true);
  f.finish("run-b");
  expect(f.predictions()).toHaveLength(1);
  await f.settle();
  expect(f.prediction()).toBeNull();
});
