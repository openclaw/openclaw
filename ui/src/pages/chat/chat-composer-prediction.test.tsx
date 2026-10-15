/* @vitest-environment jsdom */
import { nothing, render } from "lit";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createComposerContainer,
  createComposerProps,
  resetComposerFixture,
} from "./chat-composer.test-support.ts";
import { renderChatComposer } from "./components/chat-composer-render.test-support.ts";

afterEach(() => resetComposerFixture());
const suggestion = "Show me the smaller implementation first.";

function fixture(
  response: Promise<{ text: string | null }> = Promise.resolve({ text: suggestion }),
) {
  let listener: ((event: GatewayEventFrame) => void) | undefined;
  let draft = "";
  const request = vi.fn((method: string) =>
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
  const paint = () => {
    render(renderChatComposer(props), container);
    flush();
  };
  props.onRequestUpdate = paint;
  onTestFinished(() => {
    render(nothing, container);
  });
  paint();
  const input = container.querySelector("textarea")!;
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
    draft: () => draft,
    predictions: () => request.mock.calls.filter(([method]) => method === "chat.predict"),
  };
}

it("shows a prediction without changing the draft; Tab accepts but never sends", async () => {
  const f = fixture();
  f.finish();
  await waitForSolid(() =>
    expect(f.container.querySelector(".agent-chat__composer-prediction")?.textContent).toBe(
      suggestion,
    ),
  );
  expect(f.input.value).toBe("");
  expect(f.draft()).toBe("");
  f.input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );
  expect(f.props.onSend).not.toHaveBeenCalled();
  f.input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
  );
  expect(f.input.value).toBe(suggestion);
  expect(f.draft()).toBe(suggestion);
  expect(f.props.onSend).not.toHaveBeenCalled();
  expect(f.container.querySelector(".agent-chat__composer-prediction")).toBeNull();
  f.finish();
  expect(f.predictions()).toHaveLength(1);
});

it.each(["Escape", "typing"])("dismisses with %s without accepting", async (action) => {
  const f = fixture();
  f.finish();
  await waitForSolid(() =>
    expect(f.container.querySelector(".agent-chat__composer-prediction")).not.toBeNull(),
  );
  if (action === "Escape") {
    f.input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  } else {
    f.input.value = "My own question";
    f.input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  }
  flush();
  expect(f.container.querySelector(".agent-chat__composer-prediction")).toBeNull();
  expect(f.input.value).toBe(action === "typing" ? "My own question" : "");
  expect(f.props.onSend).not.toHaveBeenCalled();
});

it.each(["disabled", "hidden", "read-only", "draft", "attachment"])(
  "does not predict in a %s composer",
  async (kind) => {
    const f = fixture();
    if (kind === "disabled") {
      f.props.composerPredictions!.enabled = false;
    }
    if (kind === "hidden") {
      f.props.composerPredictions!.active = false;
    }
    if (kind === "read-only") {
      f.props.canSend = false;
    }
    if (kind === "draft") {
      f.input.value = "Existing draft";
      f.input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }
    if (kind === "attachment") {
      f.props.getPendingAttachmentReads = () => 1;
    }
    f.paint();
    f.finish();
    await Promise.resolve();
    expect(f.predictions()).toHaveLength(0);
  },
);

it.each(["session", "client", "typing", "disable"])(
  "drops an in-flight result after %s changes",
  async (kind) => {
    const response = createDeferred<{ text: string | null }>();
    const f = fixture(response.promise);
    f.finish();
    expect(f.predictions()).toHaveLength(1);
    if (kind === "session") {
      f.props.currentSessionId = "session-b";
    }
    if (kind === "client") {
      f.props.gatewayClient = { request: vi.fn() } as unknown as GatewayBrowserClient;
    }
    if (kind === "disable") {
      f.props.composerPredictions!.enabled = false;
    }
    if (kind === "typing") {
      f.input.value = "My draft";
      f.input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }
    f.paint();
    response.resolve({ text: suggestion });
    await Promise.resolve();
    flush();
    expect(f.container.querySelector(".agent-chat__composer-prediction")).toBeNull();
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
  await waitForSolid(() =>
    expect(f.container.querySelector(".agent-chat__composer-prediction")).not.toBeNull(),
  );
  const button = [...f.container.querySelectorAll("button")].find((node) =>
    node.textContent?.includes("Use suggestion"),
  )!;
  button.click();
  expect(f.draft()).toBe(suggestion);
  expect(f.props.onSend).not.toHaveBeenCalled();
});

it("discards a displayed suggestion when another run starts before its first delta", async () => {
  const f = fixture();
  f.finish();
  await waitForSolid(() =>
    expect(f.container.querySelector(".agent-chat__composer-prediction")).not.toBeNull(),
  );
  f.props.runActive = true;
  f.paint();
  expect(f.container.querySelector(".agent-chat__composer-prediction")).toBeNull();
  f.input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
  );
  expect(f.draft()).toBe("");
  expect(f.props.onSend).not.toHaveBeenCalled();
});

it("drops an in-flight prediction when a new run starts without waiting for a delta", async () => {
  const response = createDeferred<{ text: string | null }>();
  const f = fixture(response.promise);
  f.finish();
  f.props.runActive = true;
  f.paint();
  response.resolve({ text: suggestion });
  await Promise.resolve();
  flush();
  expect(f.container.querySelector(".agent-chat__composer-prediction")).toBeNull();
});
