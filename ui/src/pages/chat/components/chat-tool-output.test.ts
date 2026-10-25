/* @vitest-environment jsdom */
import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import { t } from "../../../i18n/index.ts";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import { formatToolOutput } from "../../../lib/chat/tool-output.ts";
import { mountSolid as mountComponent } from "../../../test-helpers/solid-render.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createSidebarFullMessageLoader } from "../chat-pane-sidebar-layout.ts";
import { createTestChatPane } from "../chat-pane.test-support.ts";
import { stubObjectUrls } from "./chat-message-media.test-helpers.ts";
import type { SidebarFullMessageLoader } from "./chat-sidebar-content-types.ts";
import { ChatToolOutput } from "./chat-tool-output-view.tsx";

const contentText = (...texts: string[]) =>
  JSON.stringify(
    texts.map((text) => ({ type: "input_text", text })),
    null,
    2,
  );
const toolOutput = { source: "provider-response", modelInput: "unverified" } as const;
const execution = (output: string, fields: Record<string, unknown> = {}) =>
  contentText(
    JSON.stringify({ output, chunk_id: "chunk", wall_time_seconds: 0.7, exit_code: 0, ...fields }),
  );
const truncationMarker =
  "...(OpenClaw truncated Codex native tool output: original 20000 chars, showing 10000; rerun with narrower args.)";

function outputCard(overrides: Partial<ToolCard> = {}): ToolCard {
  return {
    id: "b",
    callId: "b",
    resultMessageId: "result-b",
    name: "exec",
    args: { input: "text(await tools.exec_command({cmd: 'check-service'}));" },
    outputText: "preview",
    toolOutput,
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
          __openclaw: { toolOutput },
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
    { name: "exec", args: { code: "return result" } },
    { name: "exec", args: undefined },
  ])("keeps non-native content literal: %o", (overrides) => {
    const outputText = contentText("literal value");
    expect(formatToolOutput(outputCard({ ...overrides, outputText }))).toBe(outputText);
  });

  it.each([
    ['[{"type":"input_text","text":"partial'],
    ['[{"type":"input_text","text":"caption"},{"type":"input_image","omitted":true}]'],
    ['{"output":"data","state":"before","state":"after"}'],
  ])("does not unwrap non-text envelopes: %s", (outputText) => {
    expect(formatToolOutput(outputCard({ outputText }))).toBe(outputText);
  });

  it.each([{ session_id: 321, exit_code: undefined }, { extra: "keep this field" }])(
    "retains nonterminal or extended execution fields: %o",
    (fields) => {
      const shown = formatToolOutput(outputCard({ outputText: execution("done", fields) }))!;
      expect(JSON.parse(shown)).toEqual({
        output: "done",
        chunk_id: "chunk",
        wall_time_seconds: 0.7,
        exit_code: 0,
        ...fields,
      });
    },
  );

  it("formats native JSON without changing number lexemes or duplicate members", () => {
    const output =
      '{"id":9007199254740993,"overflow":1e400,"zero":-0,"state":"before","state":"after"}';
    const shown = formatToolOutput(outputCard({ outputText: execution(output) }))!;
    expect(shown).toBe(
      '{\n  "id": 9007199254740993,\n  "overflow": 1e400,\n  "zero": -0,\n  "state": "before",\n  "state": "after"\n}',
    );
  });

  it("renders literal failed-command output with raw details and exact copying", async () => {
    const output = "<script>danger()</script>\n**literal**";
    const raw = contentText(
      "Script completed\nWall time 0.8 seconds\nOutput:\n",
      JSON.stringify({ wall_time_seconds: 0.7, exit_code: 1, output }),
    );
    const panel = mount(
      outputCard(),
      vi.fn<SidebarFullMessageLoader>().mockResolvedValue(result(raw)),
    );
    await expectText(panel.container, `Exit code 1\n${output}`);
    expect(panel.container.querySelector("script, strong")).toBeNull();
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

  it.each([
    { name: "inline output", length: 600_000, outputTruncated: false, maxChars: 2_000_000 },
    { name: "referenced output", length: 5_000_000, outputTruncated: true, maxChars: 8_000_000 },
  ])(
    "retrieves and exports exact $name beyond the detail and Markdown caps",
    async ({ length, outputTruncated, maxChars }) => {
      const text =
        "  \r\n" + "x".repeat(length) + "\r\n\x60\x60\x60\n<strong>literal</strong> 🦞 TAIL\r\n";
      const pending = createDeferred();
      const request = vi.fn(async () => {
        await pending.promise;
        return result(text);
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
      await expectText(panel.container, text);
      expect(request).toHaveBeenCalledWith("chat.message.get", {
        sessionKey: "global",
        agentId: "work",
        messageId: "result-b",
        maxChars,
      });

      const revoke = stubObjectUrls(() => "blob:output-fixture");
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
      button(panel.container, t("chat.toolCards.downloadOutput")).click();
      expect(revoke).toHaveBeenCalledWith("blob:output-fixture");
    },
  );

  it.each(["legacy capture", "recorded capture", "oversized"] as const)(
    "keeps available output when full output is unavailable: %s",
    async (reason) => {
      const load = vi.fn<SidebarFullMessageLoader>();
      const retrieved = reason === "oversized";
      if (retrieved) {
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
            outputText: `prefix\n${truncationMarker}`,
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

  it("fetches a recorded preview before interpreting a truncation suffix", async () => {
    const marker = `literal\n${truncationMarker}`;
    const load = vi.fn<SidebarFullMessageLoader>().mockResolvedValue(result(marker));
    const panel = mount(
      outputCard({
        outputText: marker,
        outputTruncated: true,
        toolOutput: { source: "execution", modelInput: "unverified" },
      }),
      load,
    );
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(panel.container.getAttribute("aria-busy") ?? busy(panel.container)).toBe("false"),
    );
    expect(panel.container.textContent).not.toContain(t("chat.toolCards.fullOutputUnavailable"));
    expect(textOf(panel.container)).toBe(marker);
  });

  it.each(["selection", "connection"])(
    "ignores old full-output responses after a new %s",
    async (change) => {
      const pending = createDeferred<ReturnType<typeof result>>();
      const load = vi
        .fn<SidebarFullMessageLoader>()
        .mockImplementationOnce(() => pending.promise)
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
      pending.resolve(result("stale response"));
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
