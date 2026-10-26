import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ControlUiViewContext } from "../../../src/plugin-sdk/control-ui.js";
import { PRESENTATION_CHANGED_EVENT } from "../lib/presentation.ts";
import { createInitializationContext } from "../pages/chat/chat-application-context.test-support.ts";
import { threadFixture } from "../pages/chat/components/chat-transcript-fixture.test-support.tsx";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "../pages/chat/components/chat-transcript.test-support.ts";
import { render } from "../pages/chat/test-helpers/chat-transcript-native.tsx";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import { createViewRuntime, replacement } from "./control-ui-view.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

it("retires inline views when retained rows hide and remounts equal props on return", async () => {
  const contexts: ControlUiViewContext<unknown>[] = [];
  const dispose = vi.fn();
  const runtime = createViewRuntime(
    replacement("workspace", (container, context) => {
      contexts.push(context);
      container.textContent = "Incident detail";
      return { dispose };
    }),
  );
  const registration = runtime.context.plugins.selectedReplacement("workspace")!;
  Object.assign(runtime.context.plugins, {
    selectedReplacement: () => undefined,
    isLoading: () => false,
    inlineViewLabel: () => "Incident",
    registrations: (kind: string) =>
      kind === "inlineViews" ? [{ ...registration, key: "review/fixture@1" }] : [],
  });
  const applicationContext = createInitializationContext();
  Object.assign(applicationContext, { plugins: runtime.context.plugins });
  const presentation = new EventTarget();
  let visible = true;
  const props = threadProps(
    "retained-inline",
    "agent:main:incident",
    [
      {
        role: "toolResult",
        toolName: "show_incident",
        toolCallId: "incident-call",
        timestamp: 1_000,
        content: [{ type: "text", text: "Incident summary" }],
        details: {
          pluginView: {
            type: "plugin_view",
            toolCallId: "incident-call",
            toolName: "show_incident",
            pluginId: "review",
            viewId: "fixture",
            version: 1,
            payload: { incidentId: "INC-42" },
            summary: "Incident summary",
          },
        },
      },
    ],
    {
      applicationContext,
      presented: true,
      transcriptVisible: { owner: presentation, isPresented: () => visible },
    },
  );
  const { transcript, container, rerender } = threadFixture(props);
  try {
    rerender();
    transcript.start();
    await waitForSolid(() => expect(contexts).toHaveLength(1));
    const row = container.querySelector(".chat-virtual-row");
    const placeholder = container.querySelector(".chat-plugin-inline-view");
    expect(row).not.toBeNull();
    expect(placeholder?.textContent).toContain("Incident detail");
    const original = contexts[0]!;
    await expect(original.host.request("fixture.active")).resolves.toEqual({ ok: true });
    runtime.request.mockClear();

    // Keep row props and the last near-viewport receipt unchanged. The canonical
    // transcript presentation owner must retire work before another IO receipt.
    visible = false;
    presentation.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
    flush();
    await waitForSolid(() => expect(dispose).toHaveBeenCalledOnce());
    expect(original.signal.aborted).toBe(true);
    expect(placeholder?.querySelector("openclaw-plugin-view")).toBeNull();
    await expect(original.host.request("fixture.hidden")).rejects.toThrow("view has ended");
    expect(runtime.request).not.toHaveBeenCalled();

    visible = true;
    presentation.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
    flush();
    await waitForSolid(() => expect(contexts).toHaveLength(2));
    expect(container.querySelector(".chat-virtual-row")).toBe(row);
    expect(container.querySelector(".chat-plugin-inline-view")).toBe(placeholder);
    expect(placeholder?.textContent).toContain("Incident detail");
    expect(contexts[1]?.props).toEqual(original.props);
    expect(contexts[1]?.signal.aborted).toBe(false);
    await expect(original.host.request("fixture.retired")).rejects.toThrow("view has ended");
    expect(runtime.request).not.toHaveBeenCalled();
    await expect(contexts[1]!.host.request("fixture.successor")).resolves.toEqual({ ok: true });

    render(null, container);
    transcript.dispose();
    await waitForSolid(() => expect(dispose).toHaveBeenCalledTimes(2));
    expect(contexts[1]?.signal.aborted).toBe(true);
  } finally {
    render(null, container);
    transcript.dispose();
  }
});
