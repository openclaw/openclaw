/* @vitest-environment jsdom */
import { Blob as NodeBlob } from "node:buffer";
import { createComponent, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import { t } from "../../../i18n/index.ts";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { mountSolid as mountComponent } from "../../../test-helpers/solid-render.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createSidebarFullMessageLoader } from "../chat-pane-sidebar-layout.ts";
import { createTestChatPane } from "../chat-pane.test-support.ts";
import type { SidebarContent, SidebarFullMessageLoader } from "./chat-sidebar-content-types.ts";
import { mountCard } from "./chat-tool-cards.test-support.tsx";
import { ChatToolOutput } from "./chat-tool-output-view.tsx";

type NativeExecution = {
  output: string;
  chunk_id: string;
  wall_time_seconds: number;
  session_id?: number;
  exit_code?: number;
  extra?: string;
};
type NativeOutputCase = [
  string,
  { output: string; exitCode: number } | { literal: string } | { execution: NativeExecution },
];

const execution = (fields: Partial<NativeExecution>) => ({
  execution: { output: "done", chunk_id: "chunk", wall_time_seconds: 0.7, ...fields },
});
const nativeOutput = (output: string, exitCode = 0) => ({ output, exitCode });

function outputCard(overrides: Partial<ToolCard> = {}): ToolCard {
  return {
    id: "b",
    callId: "b",
    resultMessageId: "result-b",
    name: "exec",
    args: { input: "text(await tools.exec_command({cmd: 'check-service'}));" },
    outputText: "preview",
    toolOutput: { source: "provider-response", modelInput: "unverified" },
    completed: true,
    ...overrides,
  };
}

function mount(card: ToolCard, load: SidebarFullMessageLoader) {
  const props: Parameters<typeof ChatToolOutput>[0] = {
    content: { kind: "tool-output", card, sessionKey: "global", agentId: "work" },
    loadFullMessage: load,
    connectionEpoch: undefined,
  };
  const view = mountComponent(ChatToolOutput, props);
  document.body.append(view.container);
  return { ...view, props };
}

function result(text: string) {
  return {
    ok: true,
    message: {
      role: "assistant",
      __openclaw: { id: "result-b" },
      content: [
        { type: "toolResult", id: "a", name: "exec", text: "wrong sibling" },
        {
          type: "toolResult",
          id: "b",
          name: "exec",
          text,
          __openclaw: { toolOutput: { source: "provider-response", modelInput: "unverified" } },
        },
      ],
    },
  };
}

function button(root: Element, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.getAttribute("aria-label") === label || item.textContent?.trim() === label,
  );
  expect(found, label).toBeDefined();
  return found!;
}

const textOf = (root: ParentNode) => root.querySelector(".chat-tool-output__text")?.textContent;
const busy = (root: ParentNode) => root.querySelector("[aria-busy]")?.getAttribute("aria-busy");
const actions = (root: ParentNode) => root.querySelector(".chat-tool-output__actions");
const expectText = (root: ParentNode, text: string) =>
  waitForSolid(() => expect(textOf(root)).toBe(text));

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("tool output inspection", () => {
  it.each([
    { name: "lookup", args: { query: "input_text" } },
    { name: "exec", args: { command: "print-result" } },
    { name: "exec", args: { code: "return result" } },
    { name: "exec", args: undefined },
  ])(
    "keeps content-shaped data literal without native Code Mode input: %o",
    async ({ name, args }) => {
      const text = '[{"type":"input_text","text":"literal value"}]';
      const view = mountSolid(() =>
        createComponent(ChatToolOutput, {
          content: { kind: "tool-output", card: outputCard({ name, args, outputText: text }) },
        }),
      );
      await expectText(view.container, text);
    },
  );

  it.each<NativeOutputCase>([
    [
      "JSON lexemes",
      nativeOutput(
        '{"id":9007199254740993,"overflow":1e400,"zero":-0,"state":"before","state":"after"}',
      ),
    ],
    ["failed command without a chunk ID", nativeOutput("service unavailable\n", 1)],
    ["literal markup", nativeOutput("<script>danger()</script>\n**literal**")],
    ["incomplete response", { literal: '[{"type":"input_text","text":"partial' }],
    [
      "mixed media",
      { literal: '[{"type":"input_text","text":"caption"},{"type":"input_image","omitted":true}]' },
    ],
    ["ordinary JSON", { literal: '{"output":"data","state":"before","state":"after"}' }],
    ["process handle", execution({ session_id: 321, output: "still running" })],
    ["additional response fields", execution({ exit_code: 0, extra: "keep this field" })],
  ])("preserves %s during native output inspection", async (_name, testCase) => {
    const raw =
      "literal" in testCase
        ? testCase.literal
        : "execution" in testCase
          ? JSON.stringify([{ type: "input_text", text: JSON.stringify(testCase.execution) }])
          : JSON.stringify(
              [
                { type: "input_text", text: "Script completed\nWall time 0.8 seconds\nOutput:\n" },
                {
                  type: "input_text",
                  text: JSON.stringify({
                    ...(testCase.exitCode === 0 ? { chunk_id: "chunk" } : {}),
                    wall_time_seconds: 0.7,
                    exit_code: testCase.exitCode,
                    output: testCase.output,
                  }),
                },
              ],
              null,
              2,
            );
    const panel = mount(
      outputCard({ outputText: raw }),
      vi.fn<SidebarFullMessageLoader>().mockResolvedValue(result(raw)),
    );
    await vi.waitFor(() => expect(busy(panel.container)).toBe("false"));
    const shown = textOf(panel.container) ?? "";
    if ("literal" in testCase) {
      expect(shown).toBe(raw);
      return;
    }
    if ("execution" in testCase) {
      expect(JSON.parse(shown)).toEqual(testCase.execution);
      return;
    }
    const { output, exitCode } = testCase;
    expect(shown).not.toContain("chunk_id");
    expect(shown).not.toContain("input_text");
    expect(panel.container.querySelector("script, strong")).toBeNull();
    if (output.startsWith("{")) {
      expect(shown).toContain('"id": 9007199254740993');
      expect(shown).toContain('"overflow": 1e400');
      expect(shown).toContain('"zero": -0');
      expect(shown).toContain('"state": "before",');
      expect(shown).toContain('"state": "after"');
    } else {
      expect(shown).toContain(output);
    }
    if (exitCode !== 0) {
      expect(shown).toContain("Exit code 1");
    }
    const rawBody = panel.container.querySelector<HTMLElement>(".chat-tool-card__raw-body")!;
    expect(rawBody.hidden).toBe(true);
    button(panel.container, t("chat.toolCards.rawDetails")).click();
    await waitForSolid(() => expect(rawBody.hidden).toBe(false));
    expect(rawBody.querySelector("code")?.textContent).toBe(raw);
    const copy = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText: copy } });
    button(panel.container, t("chat.toolCards.copyOutput")).click();
    expect(copy).toHaveBeenCalledWith(raw);
  });

  it.each(["plain", "native"])("opens long %s output as an inspectable result", async (shape) => {
    const text = "  " + "x".repeat(150_000) + "\r\nTAIL";
    const output = shape === "native" ? JSON.stringify([{ type: "input_text", text }]) : text;
    const card = outputCard({ outputText: output });
    const open = vi.fn<(content: SidebarContent) => void>();
    const root = document.createElement("div");
    await mountCard(
      card,
      {
        messageKey: "calls",
        sessionKey: "global",
        agentId: "work",
        expanded: true,
        onToggleExpanded: vi.fn(),
        onOpenSidebar: open,
      },
      root,
    );
    expect(root.textContent).not.toContain("TAIL");
    expect(root.querySelector(".chat-tool-card__raw-body")).toBeNull();
    button(root, t("chat.toolCards.showFullOutput")).click();
    expect(open).toHaveBeenCalledWith({
      kind: "tool-output",
      card,
      sessionKey: "global",
      agentId: "work",
    });
    expect(card.outputText).toBe(output);
  });

  it("retrieves the current selection after its Solid owner remounts", async () => {
    const load = vi
      .fn<SidebarFullMessageLoader>()
      .mockResolvedValueOnce(result("first output"))
      .mockResolvedValueOnce(result("reattached output"));
    const panel = mount(outputCard(), load);
    await expectText(panel.container, "first output");
    panel.dispose();
    expect(load).toHaveBeenCalledTimes(1);
    const reattached = mount(outputCard({ outputText: "new preview" }), load);
    await expectText(reattached.container, "reattached output");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: "inline output", length: 600_000, outputTruncated: false, maxChars: 2_000_000 },
    { name: "referenced output", length: 5_000_000, outputTruncated: true, maxChars: 8_000_000 },
  ])(
    "retrieves and exports exact $name beyond the detail and Markdown caps",
    async ({ length, outputTruncated, maxChars }) => {
      const text =
        "  \r\n" + "x".repeat(length) + "\r\n\x60\x60\x60\n<strong>literal</strong> 🦞 TAIL\r\n";
      const pending = createDeferred();
      const request = vi.fn(async (_method: string, params: { maxChars: number }) => {
        await pending.promise;
        const response = result(text.slice(0, params.maxChars));
        return {
          ...response,
          message: {
            ...response.message,
            __openclaw: {
              ...response.message["__openclaw"],
              truncated: text.length > params.maxChars,
            },
          },
        };
      });
      const { state, pane } = createTestChatPane({
        client: { request } as unknown as GatewayBrowserClient,
      });
      const loader = createSidebarFullMessageLoader(state, pane.context.gateway)!;
      const panel = mount(outputCard({ outputTruncated }), loader);
      try {
        flush();
        expect(busy(panel.container)).toBe("true");
        expect(actions(panel.container)).toBeNull();
      } finally {
        pending.resolve();
      }
      await vi.waitFor(() => expect(textOf(panel.container)?.length).toBe(text.length));
      expect(textOf(panel.container)).toBe(text);
      expect(button(panel.container, t("chat.toolCards.copyOutput"))).toBeDefined();
      expect(button(panel.container, t("chat.toolCards.downloadOutput"))).toBeDefined();
      expect(request).toHaveBeenCalledWith("chat.message.get", {
        sessionKey: "global",
        agentId: "work",
        messageId: "result-b",
        maxChars,
      });
      expect(panel.container.textContent).not.toContain("wrong sibling");
      expect(panel.container.querySelector("strong")).toBeNull();
      expect(panel.container.textContent).not.toContain("Captured before context processing");

      const copy = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { clipboard: { writeText: copy } });
      button(panel.container, t("chat.toolCards.copyOutput")).click();
      await vi.waitFor(() => expect(copy).toHaveBeenCalledWith(text));
      // Use the same native Blob fixture as outbox tests; E2E covers browser downloads.
      vi.stubGlobal("Blob", NodeBlob);
      const create = vi.fn((_blob: Blob) => "blob:output-fixture");
      const revoke = vi.fn();
      vi.stubGlobal(
        "URL",
        class extends URL {
          static override createObjectURL = create;
          static override revokeObjectURL = revoke;
        },
      );
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
      button(panel.container, t("chat.toolCards.downloadOutput")).click();
      const blob = create.mock.calls[0]?.[0];
      expect(blob).toBeInstanceOf(Blob);
      expect(await blob!.text()).toBe(text);
      expect(revoke).toHaveBeenCalledWith("blob:output-fixture");
    },
  );

  it.each(["legacy capture", "recorded capture", "oversized", "not_found"] as const)(
    "keeps available output when full output is unavailable: %s",
    async (reason) => {
      const load = vi.fn<SidebarFullMessageLoader>();
      const retrieved = reason === "oversized" || reason === "not_found";
      if (reason === "oversized" || reason === "not_found") {
        load.mockResolvedValue({ ok: false, unavailableReason: reason });
      }
      const card = retrieved
        ? outputCard()
        : outputCard({
            toolOutput:
              reason === "legacy capture"
                ? undefined
                : {
                    source: "execution",
                    modelInput: "unverified",
                    captureTruncated: true,
                  },
            outputText:
              "prefix\n...(OpenClaw truncated Codex native tool output: original 20000 chars, showing 10000; rerun with narrower args.)",
          });
      const panel = mount(card, load);
      await vi.waitFor(() =>
        expect(panel.container.textContent).toContain(t("chat.toolCards.fullOutputUnavailable")),
      );
      if (!retrieved) {
        expect(load).not.toHaveBeenCalled();
      }
      expect(textOf(panel.container)).toBe(card.outputText);
    },
  );

  it.each([
    { source: "provider-response" as const, preview: false },
    { source: "execution" as const, preview: true },
    { source: "execution" as const, preview: false },
  ])(
    "fetches $source previews before interpreting a truncation suffix",
    async ({ source, preview }) => {
      const marker =
        "literal\n...(OpenClaw truncated Codex native tool output: original 20000 chars, showing 10000; rerun with narrower args.)";
      const load = vi.fn<SidebarFullMessageLoader>().mockResolvedValue(result(marker));
      const panel = mount(
        outputCard({
          outputText: marker,
          outputTruncated: preview,
          toolOutput: { source, modelInput: "unverified" },
        }),
        load,
      );
      await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
      await vi.waitFor(() =>
        expect(panel.container.getAttribute("aria-busy") ?? busy(panel.container)).toBe("false"),
      );
      expect(panel.container.textContent).not.toContain(t("chat.toolCards.fullOutputUnavailable"));
      expect(textOf(panel.container)).toBe(marker);
    },
  );

  it.each(["selection", "connection"])(
    "ignores old full-output responses after a new %s",
    async (change) => {
      let complete!: (value: ReturnType<typeof result>) => void;
      const load = vi
        .fn<SidebarFullMessageLoader>()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              complete = resolve;
            }),
        )
        .mockResolvedValueOnce(result("new selection"));
      const panel = mount(outputCard(), load);
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
      if (change === "selection") {
        panel.update({
          ...panel.props,
          content: {
            kind: "tool-output",
            card: outputCard(),
            sessionKey: "agent:other:main",
            agentId: "other",
          },
        });
      } else {
        panel.update({ ...panel.props, connectionEpoch: 2 });
      }
      await vi.waitFor(() => expect(textOf(panel.container)).toBe("new selection"));
      complete(result("stale response"));
      await Promise.resolve();
      flush();
      expect(textOf(panel.container)).toBe("new selection");
    },
  );

  it("keeps the preview visible while retrying a failed full-output read", async () => {
    const retried = createDeferred<ReturnType<typeof result>>();
    const load = vi
      .fn<SidebarFullMessageLoader>()
      .mockRejectedValueOnce(new Error("Read failed"))
      .mockImplementationOnce(() => retried.promise);
    const panel = mount(outputCard(), load);
    await waitForSolid(() =>
      expect(panel.container.querySelector('[role="alert"]')?.textContent).toContain(
        t("chat.toolCards.outputLoadFailed"),
      ),
    );

    button(panel.container, t("common.retry")).click();
    await waitForSolid(() => expect(busy(panel.container)).toBe("true"));
    expect(panel.container.querySelector('[role="alert"]')).toBeNull();
    expect(textOf(panel.container)).toBe("preview");
    expect(actions(panel.container)).toBeNull();

    retried.resolve(result("complete output"));
    await expectText(panel.container, "complete output");
    expect(busy(panel.container)).toBe("false");
    expect(actions(panel.container)).not.toBeNull();
  });
});
