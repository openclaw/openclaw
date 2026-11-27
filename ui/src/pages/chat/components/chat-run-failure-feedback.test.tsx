import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import type {
  ControlUiReplacement,
  ControlUiSurfaceProps,
  ControlUiViewContext,
} from "../../../../../src/plugin-sdk/control-ui.js";
import { createViewRuntime } from "../../../plugins/control-ui-view.test-support.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatNotice } from "./chat-notice-view.tsx";

type Feedback = ControlUiViewContext<ControlUiSurfaceProps["run-failure-feedback"]>;

it("keeps failure feedback scoped to its displayed run without replacing error or recovery controls", async () => {
  const contexts: Feedback[] = [];
  const disposed = vi.fn();
  const replacement: ControlUiReplacement<"run-failure-feedback"> = {
    id: "failure-feedback",
    label: "Failure feedback",
    surface: "run-failure-feedback",
    mount(container, context) {
      contexts.push(context);
      const receipt = document.createElement("span");
      receipt.textContent = "Plugin receipt: pending";
      container.append(receipt);
      return {
        dispose: disposed,
        update(next) {
          contexts.push(next);
        },
      };
    },
  };
  const runtime = createViewRuntime(replacement);
  const provider = createSolidApplicationContextProvider(runtime.context);
  const onRetryRun = vi.fn();
  const [runId, setRunId] = createSignal("run-a");
  const [sessionKey, setSessionKey] = createSignal("agent:example:one");
  const [repeatCount, setRepeatCount] = createSignal(1);
  const view = mountSolid(
    () => (
      <ChatNotice
        item={{
          kind: "notice",
          key: "failure",
          label: "",
          text: "",
          timestamp: 1,
          runError: { runId: runId(), summary: "Original error details" },
          repeatCount: repeatCount(),
        }}
        recovery={{
          sessionKey: sessionKey(),
          currentAgentId: "example",
          failureActionsRunId: runId(),
          onRetryRun,
        }}
      />
    ),
    { wrapper: provider.wrapper },
  );
  await waitForSolid(() => expect(view.queryByText("Plugin receipt: pending")).not.toBeNull());
  expect(contexts[0]?.props).toEqual({
    agentId: "example",
    sessionKey: "agent:example:one",
    runId: "run-a",
    repeatCount: 1,
  });
  expect(view.queryByText("Report a bug")).toBeNull();
  expect(view.container.querySelector(".chat-run-failure__log")?.textContent).toBe(
    "Original error details",
  );
  view.getByRole("button", { name: "Try again" }).click();
  expect(onRetryRun).toHaveBeenCalledExactlyOnceWith("run-a");
  const first = contexts[0]!;
  setRepeatCount(2);
  flush();
  await waitForSolid(() => expect(contexts.at(-1)?.props.repeatCount).toBe(2));
  expect(first.signal.aborted).toBe(false);
  setRunId("run-b");
  flush();
  await waitForSolid(() => expect(contexts.at(-1)?.props.runId).toBe("run-b"));
  expect(first.signal.aborted).toBe(true);
  expect(disposed).toHaveBeenCalledOnce();
  const second = contexts.at(-1)!;
  setSessionKey("agent:example:two");
  flush();
  await waitForSolid(() => expect(contexts.at(-1)?.props.sessionKey).toBe("agent:example:two"));
  expect(second.signal.aborted).toBe(true);
  runtime.select();
  await waitForSolid(() => expect(view.queryByText("Plugin receipt: pending")).toBeNull());
  expect(view.container.querySelector(".chat-run-failure__log")?.textContent).toBe(
    "Original error details",
  );
  expect(runtime.request).not.toHaveBeenCalled();
  view.unmount();
  expect(runtime.listeners.size).toBe(0);
});

it("keeps the error details when a failure-feedback mount fails", async () => {
  const runtime = createViewRuntime({
    id: "broken",
    label: "Broken feedback",
    surface: "run-failure-feedback",
    mount() {
      throw new Error("Synthetic feedback mount failure");
    },
  });
  const provider = createSolidApplicationContextProvider(runtime.context);
  const view = mountSolid(
    () => (
      <ChatNotice
        item={{
          kind: "notice",
          key: "failure",
          label: "",
          text: "",
          timestamp: 1,
          runError: { runId: "run-a", summary: "Original error details" },
        }}
        recovery={{ sessionKey: "agent:example:one", currentAgentId: "example" }}
      />
    ),
    { wrapper: provider.wrapper },
  );
  await waitForSolid(() => expect(runtime.reportError).toHaveBeenCalledOnce());
  expect(view.queryByText("Report a bug")).toBeNull();
  expect(view.container.querySelector(".chat-run-failure__log")?.textContent).toBe(
    "Original error details",
  );
  expect(runtime.request).not.toHaveBeenCalled();
});
