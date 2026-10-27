import { createSignal, For } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { syncControlUiSystemChrome } from "../../app/control-ui-presentation.ts";
import type { MessageGroup as MessageGroupData } from "../../lib/chat/chat-types.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { groupMessages } from "./chat-thread-grouping.ts";
import { MessageGroup } from "./components/chat-message-group-view.tsx";
import { StreamGroup } from "./components/chat-message-stream-view.tsx";
import { WorkGroupSummary } from "./components/chat-work-group-summary.tsx";
import "../../styles/base.css";
import "../../styles/components.css";
import "../../styles/chat.ts";
import "../../styles/chat/composer-surface.css";

const paragraph =
  "The conversation keeps every participant's content inside the shared column. ".repeat(20);
const code = `\`\`\`text\n${"long-unbroken-output-".repeat(80)}\n\`\`\``;
// Exercise the scroll fallback with values that cannot wrap at spaces or hyphens.
const table = `| ${Array.from({ length: 12 }, (_, i) => `Column ${i}`).join(" | ")} |\n| ${"--- | ".repeat(12)}\n| ${"unbrokentablevalueunbrokentablevalue | ".repeat(12)}`;
const image = {
  type: "image",
  data: "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHElEQVR4nGP4z8DwnxLMMGrAsDCAQv2jBgwPAwAxtf4Q24P5oAAAAABJRU5ErkJggg==",
  mimeType: "image/png",
};
const options = {
  userId: "alice",
  userName: "Alice Chen",
  assistantName: "Assistant",
  showReasoning: false,
};

function group(key: string, role: string, content: unknown, extra: Partial<MessageGroupData> = {}) {
  const [prepared] = groupMessages([
    { kind: "message", key, message: { role, content, timestamp: 1_000 } },
  ]);
  if (prepared?.kind !== "group") {
    throw new Error(`Expected rendered group for ${key}`);
  }
  return { ...prepared, key, ...extra };
}

const fixtures = [
  group("paragraph", "assistant", paragraph),
  group("code", "assistant", code),
  group("table", "assistant", table),
  group("image", "assistant", [image]),
  group("gallery", "assistant", [image, { ...image, alt: "Second image" }]),
  group("file", "assistant", [
    {
      type: "attachment",
      attachment: {
        url: "https://example.invalid/report.txt",
        kind: "document",
        label: "report.txt",
        mimeType: "text/plain",
      },
    },
  ]),
  group("peer", "user", paragraph, { sender: { id: "peer", name: "Other Sender" } }),
  group("forwarded", "assistant", paragraph, {
    senderSession: { sessionKey: "agent:research:main", agentId: "research", label: "Research" },
  }),
  group("cron", "assistant", paragraph, {
    senderSession: { sessionKey: "agent:main:cron:daily:run:fixture", agentId: "main" },
  }),
  group("report", "assistant", `# Report\n\n${paragraph}\n\n${code}`),
  group("tool", "assistant", [
    {
      type: "toolcall",
      id: "read-fixture",
      name: "read",
      arguments: { path: "/workspace/report.txt" },
    },
  ]),
];

const ownGroup = group("own", "user", paragraph, {
  sender: { id: "alice", name: "Alice Chen", identity: { type: "profile", id: "alice" } },
});
const stream = {
  kind: "stream" as const,
  key: "stream",
  text: code,
  startedAt: 1_000,
  isStreaming: true,
};
const working = { kind: "reading-indicator" as const, key: "working", startedAt: 1_000 };
const visibleBlocks = [
  ["paragraph", ".chat-text p"],
  ["code", ".code-block-wrapper"],
  ["table", ".markdown-table"],
  ["image", ".chat-message-images--single"],
  ["gallery", ".chat-message-images--gallery.chat-message-images--two-column"],
  ["file", ".chat-assistant-attachment-card"],
  ["peer", ".chat-text p"],
  ["forwarded", ".chat-reply-attribution--forwarded"],
  ["cron", ".markdown-session-link--automation"],
  ["report", ".chat-text h1"],
  [
    "tool",
    '.chat-tool-msg-summary [aria-expanded="true"], .chat-tool-msg-summary[aria-expanded="true"]',
  ],
  ["tool", ".chat-tool-msg-body"],
  ["summary", '.chat-work-group > .chat-activity-group__summary[aria-expanded="false"]'],
  ["stream", ".code-block-wrapper"],
  ["working", ".chat-reading-indicator"],
] as const;
const boundedBlocks =
  ".chat-bubble, .code-block-viewport, .markdown-table__viewport, .chat-message-images, .chat-assistant-attachment-card, .chat-activity-group, .chat-tool-msg-summary, .chat-tool-msg-body, .chat-reply-attribution";

async function assertColumn(
  root: HTMLElement,
  width: number,
  rtl: boolean,
  fullWidth: boolean,
  context: string,
) {
  const q = (selector: string) => root.querySelector<HTMLElement>(selector)!;
  const all = <T extends Element = HTMLElement>(selector: string) => [
    ...root.querySelectorAll<T>(selector),
  ];
  const edge = (node: Element) => {
    const rect = node.getBoundingClientRect();
    return rtl ? -rect.left : rect.right;
  };
  const bound = (excess: number, detail: string) =>
    expect(excess, `${context}: ${detail}`).toBeLessThanOrEqual(1);
  const own = q('[data-chat-row-key="own"] .chat-bubble');
  const ownName = q('[data-chat-row-key="own"] .chat-sender-name');
  expect(own).not.toBeNull();
  expect(ownName).not.toBeNull();
  const boundary = edge(own);
  // Mobile actions put the bubble edge on the footer, not the name.
  const ownFooter = q('[data-chat-row-key="own"] > .chat-group-footer');
  bound(Math.abs(edge(width <= 768 ? ownFooter : ownName) - boundary), "own footer");
  const leftGroups = all('.chat-group:not([data-chat-row-key="own"])');
  expect(leftGroups).toHaveLength(fixtures.length + 3);
  for (const left of leftGroups) {
    const excess = edge(left.querySelector(".chat-group-messages")!) - boundary;
    bound(
      fullWidth && !left.classList.contains("chat-group--peer") ? Math.abs(excess) : excess,
      `${left.getAttribute("data-chat-row-key")} column`,
    );
    for (const block of left.querySelectorAll(boundedBlocks)) {
      bound(edge(block) - boundary, block.className);
    }
  }
  for (const [key, selector] of visibleBlocks) {
    const block = q(`[data-chat-row-key="${key}"]`).querySelector(selector);
    expect(block, `${context}: ${key} ${selector}`).not.toBeNull();
    expect(
      block!.getBoundingClientRect().width,
      `${context}: ${key} visible block`,
    ).toBeGreaterThan(0);
  }
  for (const [key, count] of [
    ["image", 1],
    ["gallery", 2],
  ] as const) {
    const images = all<HTMLImageElement>(`[data-chat-row-key="${key}"] img.chat-message-image`);
    expect(images, `${context}: ${key} image count`).toHaveLength(count);
    // Admit lazy images to the viewport before decoding their geometry.
    for (const element of images) {
      element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      await element.decode();
      expect(element.naturalWidth).toBeGreaterThan(0);
    }
  }
  for (const selector of [".code-block-wrapper", ".markdown-table"]) {
    const viewport = [...q(selector).querySelectorAll<HTMLElement>("*")].find(
      (node) =>
        node.scrollWidth > node.clientWidth &&
        ["auto", "scroll"].includes(getComputedStyle(node).overflowX),
    );
    expect(viewport, `${context}: ${selector} internal scroll`).toBeDefined();
    viewport!.scrollLeft = getComputedStyle(viewport!).direction === "rtl" ? -64 : 64;
    expect(Math.abs(viewport!.scrollLeft)).toBeGreaterThan(0);
  }
  const thread = q(".chat-thread");
  bound(thread.scrollWidth - thread.clientWidth, "thread overflow");
}

it.each([1440, 1024, 390].flatMap((width) => ["light", "dark"].map((theme) => ({ width, theme }))))(
  "bounds every left-side block at $width px in $theme",
  async ({ width, theme }) => {
    await page.viewport(width, 900);
    const root = document.body.appendChild(document.createElement("div"));
    root.className = "chat";
    root.style.height = "850px";
    const previousTheme = document.documentElement.dataset.themeMode;
    document.documentElement.dataset.themeMode = theme;
    onTestFinished(() => {
      root.remove();
      if (previousTheme === undefined) {
        delete document.documentElement.dataset.themeMode;
      } else {
        document.documentElement.dataset.themeMode = previousTheme;
      }
    });
    const [directLayout, setDirectLayout] = createSignal(false);
    mountSolid(
      () => (
        <div
          class={["chat-thread", { "chat-thread--direct": directLayout() }]}
          style={{ height: "850px" }}
        >
          <div class="chat-thread-inner">
            <MessageGroup group={ownGroup} options={options} />
            <For each={fixtures}>
              {(fixture) => (
                <MessageGroup
                  group={fixture}
                  options={{ ...options, isToolExpanded: () => true }}
                />
              )}
            </For>
            <WorkGroupSummary
              item={{ key: "summary", durationMs: 2_000, groups: [] }}
              options={{ expanded: false, onToggle: () => {} }}
            />
            <StreamGroup options={{}} parts={[stream]} />
            <StreamGroup options={{}} parts={[working]} />
          </div>
        </div>
      ),
      { container: root },
    );
    await vi.dynamicImportSettled();
    await waitForSolid(() => {
      for (const [key, selector] of visibleBlocks) {
        expect(
          root.querySelector(`[data-chat-row-key="${key}"]`)?.querySelector(selector),
        ).toBeInstanceOf(HTMLElement);
      }
    });
    for (const direct of [false, true]) {
      for (const direction of ["ltr", "rtl"]) {
        for (const mode of ["saved", "narrow", "default"]) {
          const fullWidth = mode !== "default";
          // A narrow desktop pane retains avatars; the mobile viewport hides them.
          for (const [property, enabled] of [
            ["--chat-message-max-width", fullWidth],
            ["--chat-thread-max-width", mode === "saved"],
          ] as const) {
            if (enabled) {
              root.style.setProperty(property, "100%");
            } else {
              root.style.removeProperty(property);
            }
          }
          root.dir = direction;
          root.style.width = mode === "narrow" ? "min(100%, 480px)" : "100%";
          setDirectLayout(direct);
          flush();
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          });
          await assertColumn(
            root,
            width,
            direction === "rtl",
            fullWidth,
            `${width}/${theme}/${direct ? "direct" : "shared"}/${direction}/${mode}`,
          );
        }
      }
    }
  },
);

it.each(["light", "dark"])(
  "updates viewer and link colors without recoloring peers (%s)",
  async (mode) => {
    const root = document.body.appendChild(document.createElement("div"));
    root.className = "chat";
    const documentRoot = document.documentElement;
    const previousAttributes = ["data-theme", "data-theme-mode", "style"].map(
      (name) => [name, documentRoot.getAttribute(name)] as const,
    );
    documentRoot.dataset.theme = mode;
    documentRoot.dataset.themeMode = mode;
    const style = documentRoot.style;
    onTestFinished(() => {
      root.remove();
      for (const [name, value] of previousAttributes) {
        if (value === null) documentRoot.removeAttribute(name);
        else documentRoot.setAttribute(name, value);
      }
      syncControlUiSystemChrome(true);
    });
    const groups = ["alice", "bob"].map((id) =>
      group(
        id,
        "user",
        "A message. [Guide](https://example.com/guide) [#1](https://github.com/openclaw/openclaw/issues/1)",
        {
          sender: { id, name: id, identity: { type: "profile", id } },
        },
      ),
    );
    mountSolid(
      () => (
        <div class="chat-thread">
          <For each={groups}>{(item) => <MessageGroup group={item} options={options} />}</For>
        </div>
      ),
      { container: root },
    );
    const colors = (id: string) => {
      const entry = root.querySelector('[data-chat-row-key="' + id + '"]')!;
      return {
        bubble: getComputedStyle(entry.querySelector(".chat-bubble")!).backgroundColor,
        name: getComputedStyle(entry.querySelector(".chat-sender-name")!).color,
      };
    };
    style.setProperty("--accent", "#a04c29");
    syncControlUiSystemChrome(true);
    await waitForSolid(() => expect(root.querySelectorAll(".chat-bubble")).toHaveLength(2));
    const viewer = colors("alice");
    const peer = colors("bob");
    expect(peer.bubble).not.toBe(viewer.bubble);
    style.setProperty("--accent", "#367f9b");
    syncControlUiSystemChrome(true);
    await waitForSolid(() => expect(colors("alice").bubble).not.toBe(viewer.bubble));
    expect(colors("alice").name).not.toBe(viewer.name);
    expect(colors("bob")).toEqual(peer);

    const link = root.querySelector<HTMLElement>(".chat-group.user .chat-text a")!;
    const colorProbe = root.appendChild(document.createElement("span"));
    colorProbe.hidden = true;
    const luminance = (color: string) => {
      colorProbe.style.color = "color(from " + color + " srgb-linear r g b)";
      const resolved = getComputedStyle(colorProbe).color;
      expect(resolved.startsWith("color(srgb-linear ")).toBe(true);
      const [r, g, b] = resolved
        .slice(resolved.indexOf(" ") + 1, -1)
        .split(/\s+/u)
        .map(Number);
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const contrast = (ink: string, fill: string) => {
      const [first, second] = [ink, fill].map(luminance);
      return (Math.max(first!, second!) + 0.05) / (Math.min(first!, second!) + 0.05);
    };
    // Script focus matches :focus-visible only after keyboard input; parallel files' clicks reset that.
    await userEvent.keyboard("{Tab}");
    for (const bubble of root.querySelectorAll<HTMLElement>(".chat-bubble")) {
      const fill = getComputedStyle(bubble).backgroundColor;
      expect(
        contrast(getComputedStyle(bubble.querySelector(".chat-text")!).color, fill),
      ).toBeGreaterThanOrEqual(4.5);
      const chip = bubble.querySelector<HTMLElement>(".markdown-github-item")!;
      chip.focus();
      expect(chip.matches(":focus-visible")).toBe(true);
      expect(contrast(getComputedStyle(chip).outlineColor, fill)).toBeGreaterThanOrEqual(3);
    }
    expect(
      contrast(colors("bob").name, getComputedStyle(document.body).backgroundColor),
    ).toBeGreaterThanOrEqual(4.5);
    const unchanged = colors("alice");
    for (const hover of [false, true]) {
      if (hover) await page.elementLocator(link).hover();
      const token = hover ? "--link-hover" : "--link";
      style.setProperty(token, "#888888");
      syncControlUiSystemChrome(true);
      flush();
      const previousInk = getComputedStyle(link).color;
      style.setProperty(token, "#6688bb");
      syncControlUiSystemChrome(true);
      await waitForSolid(() => expect(getComputedStyle(link).color).not.toBe(previousInk));
      await Promise.all(link.getAnimations().map((animation) => animation.finished));
      expect(
        contrast(
          getComputedStyle(link).color,
          getComputedStyle(link.closest(".chat-bubble")!).backgroundColor,
        ),
      ).toBeGreaterThanOrEqual(7);
      expect(colors("alice")).toEqual(unchanged);
    }
    await page.elementLocator(document.body).hover({ position: { x: 0, y: 0 } });
  },
);
