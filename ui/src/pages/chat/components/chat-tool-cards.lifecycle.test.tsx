/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import { prepareChatMessageRender } from "../../../lib/chat/message-display.ts";
import type { ToolCardOutput } from "../../../lib/chat/tool-cards.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { inlineCommandPresentation } from "../chat-inline-command-presentation.ts";
import type { GroupedMessageOptions } from "./chat-message-bubble-options.ts";
import { prepareGroupedMessage } from "./chat-message-bubble-presentation.ts";
import { BubbleToolCards } from "./chat-message-bubble-tools.tsx";
import { ExpandedToolCardContent } from "./chat-message-deferred.tsx";
import { ChatToolCard } from "./chat-tool-cards.solid.tsx";

it("unwraps provider output in the compact trail without reformatting captured JSON", async () => {
  const inlineCommands = await inlineCommandPresentation();
  const text = '{"id":9007199254740993,"state":"before","state":"after"}';
  const outputText = JSON.stringify([
    { type: "input_text", text: "Script completed\nWall time 0.8 seconds\nOutput:\n" },
    {
      type: "input_text",
      text: JSON.stringify({ wall_time_seconds: 0.7, exit_code: 1, output: text }),
    },
  ]);
  const view = mountSolid(() => (
    <ChatToolCard
      card={{
        id: "literal-preview",
        name: "exec",
        args: { input: "inspect()" },
        outputText,
        toolOutput: { source: "provider-response", modelInput: "unverified" },
        completed: true,
      }}
      options={{
        messageKey: "literal-preview",
        inlineCommands,
        runActive: true,
        expanded: false,
        onToggleExpanded: vi.fn(),
      }}
    />
  ));
  onTestFinished(view.unmount);
  await waitForSolid(() =>
    expect(view.container.querySelector(".chat-command-trail__preview pre")?.textContent).toBe(
      `Exit code 1\n${text}`,
    ),
  );
});

it.each(["command", "generic"] as const)(
  "advances expanded %s output without enumerating static input again",
  async (kind) => {
    let reads = 0;
    const args = {
      ...(kind === "command" ? { command: "printf progress" } : {}),
      get extra() {
        reads += 1;
        return "Retain this input";
      },
    };
    const card: ToolCard = {
      id: "live-input",
      name: kind === "command" ? "exec" : "tool_call",
      args: kind === "command" ? args : { id: "inspect", args },
      inputText: JSON.stringify(args),
      outputText: "Original captured output",
      live: true,
      completed: false,
    };
    const onOpenSidebar = vi.fn();
    let update!: (value: ToolCardOutput) => void;
    const view = mountSolid(() => {
      const [output, setOutput] = createSignal<ToolCardOutput>({ outputText: "First output" });
      update = setOutput;
      return (
        <ExpandedToolCardContent
          card={card}
          output={output()}
          options={{ messageKey: "live-input", runActive: true, onOpenSidebar }}
        />
      );
    });
    onTestFinished(view.unmount);
    await waitForSolid(() => expect(view.container.textContent).toContain("First output"));
    expect(view.container.textContent).toContain("Retain this input");
    const before = reads;
    const input = view.container.querySelector(".chat-tool-kv");
    update({ outputText: "Latest output" });
    await waitForSolid(() => expect(view.container.textContent).toContain("Latest output"));
    expect(view.container.querySelector(".chat-tool-kv")).toBe(input);
    expect(reads).toBe(before);
    view.container.querySelector<HTMLButtonElement>(".chat-tool-card__action-btn")!.click();
    expect(onOpenSidebar).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "tool-output",
        card: expect.objectContaining({
          id: card.id,
          name: card.name,
          args: card.args,
          outputText: "Latest output",
          completed: false,
        }),
      }),
    );
    update({ outputText: "" });
    await waitForSolid(() => expect(view.container.textContent).not.toContain("Latest output"));
    expect(reads).toBe(before);
    expect(view.container.textContent).toContain("Retain this input");
  },
);

it("remeasures each disclosure's own content on pointer and focus interactions", async () => {
  const { container } = mountSolid(() => (
    <>
      <ChatToolCard
        card={{ id: "first", name: "exec", args: { command: "first command" } }}
        options={{ messageKey: "first", expanded: false, onToggleExpanded: vi.fn() }}
      />
      <ChatToolCard
        card={{ id: "second", name: "exec", args: { command: "second command" } }}
        options={{ messageKey: "second", expanded: false, onToggleExpanded: vi.fn() }}
      />
    </>
  ));
  await waitForSolid(() =>
    expect(container.querySelectorAll(".chat-tool-row:not([aria-busy])")).toHaveLength(2),
  );
  const [first, second] = [...container.querySelectorAll<HTMLElement>(".chat-tool-row")];
  let firstWidth = 80;
  for (const [row, width] of [
    [first!, () => firstWidth],
    [second!, () => 20],
  ] as const) {
    Object.defineProperties(row.querySelector(".chat-tool-disclosure__content")!, {
      scrollWidth: { get: width },
      clientWidth: { value: 50 },
    });
    row.dispatchEvent(new Event("pointerenter"));
  }
  expect(first!.classList.contains("chat-tool-disclosure--overflowing")).toBe(true);
  expect(second!.classList.contains("chat-tool-disclosure--overflowing")).toBe(false);
  firstWidth = 20;
  first!.dispatchEvent(new FocusEvent("focus"));
  expect(first!.classList.contains("chat-tool-disclosure--overflowing")).toBe(false);
});

it("keeps keyed bubble rows while forwarding replaced options and live disclosure overrides", async () => {
  const inlineCommands = await inlineCommandPresentation();
  const initialToggle = vi.fn();
  const latestToggle = vi.fn();
  const options: GroupedMessageOptions & { showApprovalReviews: boolean } = {
    isStreaming: false,
    showReasoning: false,
    inlineCommands,
    runActive: true,
    showApprovalReviews: false,
    onToggleToolExpanded: initialToggle,
  };
  const prepared = prepareGroupedMessage(
    prepareChatMessageRender({
      role: "assistant",
      content: ["first", "second"].map((id) => ({
        type: "toolcall",
        id,
        name: "exec",
        arguments: { command: `printf ${id}` },
      })),
    }),
    "bubble-options",
    options,
  );
  prepared.toolCards = prepared.toolCards.map((card) => ({
    ...card,
    live: true,
    outputText: `${card.id} output`,
    details: { approvalReviews: [{ id: "review", label: "Reviewer", status: "approved" }] },
  }));
  const [state, setState] = createSignal(prepared);
  const view = mountSolid(() => (
    <BubbleToolCards state={state} options={options} messageKey="bubble-options" />
  ));
  onTestFinished(view.unmount);
  await waitForSolid(() =>
    expect(view.container.querySelectorAll(".chat-tool-row:not([aria-busy])")).toHaveLength(2),
  );
  const rows = [...view.container.querySelectorAll<HTMLButtonElement>(".chat-tool-row")];
  expect(rows.map((row) => row.querySelector(".chat-tool-row__cmd")?.textContent)).toEqual([
    "printf first",
    "printf second",
  ]);
  expect(view.container.querySelectorAll(".chat-command-trail__preview")).toHaveLength(2);
  expect(view.container.querySelectorAll(".chat-tool-review")).toHaveLength(2);
  rows[0]!.click();
  expect(initialToggle).toHaveBeenLastCalledWith("bubble-options:toolcard:0", false);

  setState((current) => ({
    ...current,
    isStandaloneToolMessage: true,
    toolRenderOptions: {
      ...current.toolRenderOptions,
      inlineCommands: undefined,
      runActive: false,
      onToggleToolExpanded: latestToggle,
    },
  }));
  await waitForSolid(() =>
    expect(view.container.querySelectorAll(".chat-command-trail__preview")).toHaveLength(0),
  );
  expect(
    view.container.querySelectorAll(".chat-tool-review, .chat-tool-row--running"),
  ).toHaveLength(0);
  rows[1]!.click();
  expect(latestToggle).toHaveBeenLastCalledWith("bubble-options:toolcard:1", false);

  setState((current) => ({
    ...current,
    isStandaloneToolMessage: false,
    toolRenderOptions: {
      ...current.toolRenderOptions,
      inlineCommands,
      runActive: true,
      isToolExpanded: () => true,
    },
  }));
  await waitForSolid(() =>
    expect(view.container.querySelectorAll(".chat-tool-term__out code")).toHaveLength(2),
  );
  expect(
    view.container.querySelectorAll(".chat-tool-review, .chat-tool-row--running"),
  ).toHaveLength(4);
  view.container.querySelectorAll(".chat-tool-row").forEach((row, index) => {
    expect(row).toBe(rows[index]);
  });
  rows[0]!.click();
  expect(latestToggle).toHaveBeenLastCalledWith("bubble-options:toolcard:0", true);
});

it.each([
  { hasChildren: undefined, mode: "inferred" },
  { hasChildren: true, mode: "explicit" },
])(
  "connects nested tool children only after their parent expands ($mode)",
  async ({ hasChildren, mode }) => {
    const connected = vi.fn();
    customElements.define(
      `openclaw-test-lazy-tool-child-${mode}`,
      class extends HTMLElement {
        connectedCallback() {
          connected();
        }
      },
    );
    const card = { id: "lazy-parent", name: "exec", args: { command: "check" } };
    const child = document.createElement(`openclaw-test-lazy-tool-child-${mode}`);
    child.textContent = "Child";
    const [expanded, setExpanded] = createSignal(false);
    const { container } = mountSolid(() => (
      <ChatToolCard
        card={card}
        options={{
          messageKey: "lazy-parent-message",
          expanded: expanded(),
          onToggleExpanded: vi.fn(),
        }}
        hasChildren={hasChildren}
      >
        {child}
      </ChatToolCard>
    ));
    flush();
    expect(connected).not.toHaveBeenCalled();
    setExpanded(true);
    await waitForSolid(() => expect(connected).toHaveBeenCalledOnce());
    expect(container.querySelector(".chat-tool-children")?.textContent).toContain("Child");
  },
);
