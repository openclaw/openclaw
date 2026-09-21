/* @vitest-environment jsdom */
import { Blob as NodeBlob } from "node:buffer";
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import { t } from "../../../i18n/index.ts";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import { createSidebarFullMessageLoader } from "../chat-pane-sidebar-layout.ts";
import "./chat-detail-slot.ts";
import type {
  SidebarContent,
  SidebarFullMessageLoader,
  ToolOutputSidebarContent,
} from "./chat-sidebar-content-types.ts";
import { renderToolCard } from "./chat-tool-cards.ts";

type Panel = HTMLElement & {
  content: ToolOutputSidebarContent;
  loadFullMessage: SidebarFullMessageLoader | null;
  connectionEpoch?: number;
  updateComplete: Promise<unknown>;
};

function outputCard(overrides: Partial<ToolCard> = {}): ToolCard {
  return {
    id: "b",
    callId: "b",
    resultMessageId: "result-b",
    name: "exec",
    outputText: "preview",
    toolOutput: { source: "provider-response", modelInput: "unverified" },
    completed: true,
    ...overrides,
  };
}

function mount(card: ToolCard, load: SidebarFullMessageLoader): Panel {
  const panel = document.createElement("openclaw-chat-tool-output") as Panel;
  panel.content = { kind: "tool-output", card, sessionKey: "global", agentId: "work" };
  panel.loadFullMessage = load;
  document.body.append(panel);
  return panel;
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

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("tool output inspection", () => {
  it("opens long output as an inspectable result, not a Markdown preview", () => {
    const output = "  " + "x".repeat(150_000) + "\r\nTAIL";
    const card = outputCard({ outputText: output });
    const open = vi.fn<(content: SidebarContent) => void>();
    const root = document.createElement("div");
    render(
      renderToolCard(card, {
        messageKey: "calls",
        sessionKey: "global",
        agentId: "work",
        expanded: true,
        onToggleExpanded: vi.fn(),
        onOpenSidebar: open,
      }),
      root,
    );
    expect(root.textContent).not.toContain("TAIL");
    button(root, t("chat.toolCards.showFullOutput")).click();
    expect(open).toHaveBeenCalledWith({
      kind: "tool-output",
      card,
      sessionKey: "global",
      agentId: "work",
    });
    expect(card.outputText).toBe(output);
  });

  it("starts loading in the first render without scheduling a redundant update", async () => {
    let complete!: (value: ReturnType<typeof result>) => void;
    const pending = new Promise<ReturnType<typeof result>>((resolve) => {
      complete = resolve;
    });
    const panel = mount(outputCard(), vi.fn<SidebarFullMessageLoader>().mockReturnValue(pending));
    try {
      await expect(panel.updateComplete).resolves.toBe(true);
      expect(panel.querySelector("[aria-busy]")?.getAttribute("aria-busy")).toBe("true");
      expect(panel.querySelector(".chat-tool-output__actions")).toBeNull();
    } finally {
      complete(result("resolved output"));
    }
    await vi.waitFor(() =>
      expect(panel.querySelector(".chat-tool-output__text")?.textContent).toBe("resolved output"),
    );
    expect(button(panel, t("chat.toolCards.copyOutput"))).toBeDefined();
    expect(button(panel, t("chat.toolCards.downloadOutput"))).toBeDefined();
  });

  it("defers detached selection changes and retrieves the new result when reattached", async () => {
    const load = vi
      .fn<SidebarFullMessageLoader>()
      .mockResolvedValueOnce(result("first output"))
      .mockResolvedValueOnce(result("reattached output"));
    const panel = mount(outputCard(), load);
    await vi.waitFor(() =>
      expect(panel.querySelector(".chat-tool-output__text")?.textContent).toBe("first output"),
    );
    panel.remove();
    panel.content = { ...panel.content, card: outputCard({ outputText: "new preview" }) };
    await panel.updateComplete;
    expect(load).toHaveBeenCalledTimes(1);
    document.body.append(panel);
    await vi.waitFor(() =>
      expect(panel.querySelector(".chat-tool-output__text")?.textContent).toBe("reattached output"),
    );
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("retrieves and exports exact text beyond the inherited detail and Markdown caps", async () => {
    const text =
      "  \r\n" + "x".repeat(600_000) + "\r\n\x60\x60\x60\n<strong>literal</strong> 🦞 TAIL\r\n";
    const request = vi.fn(async (_method: string, params: { maxChars: number }) => {
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
    const loader = createSidebarFullMessageLoader(
      { client: { request } as unknown as GatewayBrowserClient, connected: true },
      false,
    )!;
    const panel = mount(outputCard(), loader);
    await vi.waitFor(() =>
      expect(panel.querySelector(".chat-tool-output__text")?.textContent?.length).toBe(text.length),
    );
    expect(panel.querySelector(".chat-tool-output__text")?.textContent).toBe(text);
    expect(request).toHaveBeenCalledWith("chat.message.get", {
      sessionKey: "global",
      agentId: "work",
      messageId: "result-b",
      maxChars: 2_000_000,
    });
    expect(panel.textContent).not.toContain("wrong sibling");
    expect(panel.querySelector("strong")).toBeNull();
    expect(panel.textContent).toContain(t("chat.toolCards.providerResponseNote"));

    const copy = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText: copy } });
    button(panel, t("chat.toolCards.copyOutput")).click();
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
    button(panel, t("chat.toolCards.downloadOutput")).click();
    const blob = create.mock.calls[0]?.[0];
    expect(blob).toBeInstanceOf(Blob);
    expect(await blob!.text()).toBe(text);
    expect(revoke).toHaveBeenCalledWith("blob:output-fixture");
  });

  it.each([
    undefined,
    {
      source: "execution" as const,
      modelInput: "unverified" as const,
      captureTruncated: true as const,
    },
  ])(
    "marks recorded capture loss unavailable without offering a false recovery (%s)",
    async (toolOutput) => {
      const card = outputCard({
        toolOutput,
        outputText:
          "prefix\n...(OpenClaw truncated Codex native tool output: original 20000 chars, showing 10000; rerun with narrower args.)",
      });
      const load = vi.fn<SidebarFullMessageLoader>();
      const panel = mount(card, load);
      await vi.waitFor(() =>
        expect(panel.textContent).toContain(t("chat.toolCards.fullOutputUnavailable")),
      );
      expect(load).not.toHaveBeenCalled();
      expect(panel.querySelector(".chat-tool-output__text")?.textContent).toBe(card.outputText);
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
        expect(
          panel.getAttribute("aria-busy") ??
            panel.querySelector("[aria-busy]")?.getAttribute("aria-busy"),
        ).toBe("false"),
      );
      expect(panel.textContent).not.toContain(t("chat.toolCards.fullOutputUnavailable"));
      expect(panel.querySelector(".chat-tool-output__text")?.textContent).toBe(marker);
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
        panel.content = {
          kind: "tool-output",
          card: outputCard(),
          sessionKey: "agent:other:main",
          agentId: "other",
        };
      } else {
        panel.connectionEpoch = 2;
      }
      await vi.waitFor(() =>
        expect(panel.querySelector(".chat-tool-output__text")?.textContent).toBe("new selection"),
      );
      complete(result("stale response"));
      await Promise.resolve();
      await panel.updateComplete;
      expect(panel.querySelector(".chat-tool-output__text")?.textContent).toBe("new selection");
    },
  );

  it.each(["oversized", "not_found"] as const)(
    "keeps available output when retrieval reports %s",
    async (unavailableReason) => {
      const panel = mount(
        outputCard(),
        vi.fn<SidebarFullMessageLoader>().mockResolvedValue({ ok: false, unavailableReason }),
      );
      await vi.waitFor(() =>
        expect(panel.textContent).toContain(t("chat.toolCards.fullOutputUnavailable")),
      );
      expect(panel.querySelector(".chat-tool-output__text")?.textContent).toBe("preview");
    },
  );
});
