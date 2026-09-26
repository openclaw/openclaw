import { html, nothing, render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import type { MessageGroup } from "../../lib/chat/chat-types.ts";
import { groupMessages } from "./chat-thread-grouping.ts";
import { renderMessageGroup } from "./components/chat-message-group.ts";
import { renderStreamGroup, renderWorkGroupSummary } from "./components/chat-message-stream.ts";
import "../../styles/base.css";
import "../../styles/components.css";
import "../../styles/chat.ts";

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

function group(key: string, role: string, content: unknown, extra: Partial<MessageGroup> = {}) {
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

describe("shared chat content column", () => {
  let container: HTMLDivElement | undefined;
  let previousTheme: string | undefined;

  afterEach(() => {
    if (container) {
      render(nothing, container);
      container.remove();
      container = undefined;
    }
    if (previousTheme === undefined) {
      delete document.documentElement.dataset.themeMode;
    } else {
      document.documentElement.dataset.themeMode = previousTheme;
    }
  });

  for (const width of [1440, 1024, 390]) {
    for (const theme of ["light", "dark"]) {
      it(`bounds every left-side block at ${width}px in ${theme}`, async () => {
        await page.viewport(width, 900);
        container = document.createElement("div");
        previousTheme = document.documentElement.dataset.themeMode;
        document.documentElement.dataset.themeMode = theme;
        document.body.append(container);

        for (const direct of [false, true]) {
          for (const direction of ["ltr", "rtl"]) {
            // A narrow desktop pane retains its avatar gutter; mobile uses the
            // viewport breakpoint that hides avatars in production.
            for (const mode of ["saved", "narrow", "default"]) {
              const narrow = mode === "narrow";
              const fullWidth = mode !== "default";
              if (fullWidth) {
                container.style.setProperty("--chat-message-max-width", "100%");
              } else {
                container.style.removeProperty("--chat-message-max-width");
              }
              container.dir = direction;
              container.style.width = narrow ? "min(100%, 480px)" : "100%";
              render(
                html`
                  <div
                    class=${`chat-thread${direct ? " chat-thread--direct" : ""}`}
                    style="height: 850px"
                  >
                    ${renderMessageGroup(
                      group("own", "user", paragraph, {
                        sender: {
                          id: "alice",
                          name: "Alice Chen",
                          identity: { type: "profile", id: "alice" },
                        },
                      }),
                      options,
                    )}
                    ${fixtures.map((fixture) =>
                      renderMessageGroup(fixture, {
                        ...options,
                        isToolExpanded: () => true,
                      }),
                    )}
                    ${renderWorkGroupSummary(
                      { key: "summary", durationMs: 2_000, groups: [] },
                      {
                        expanded: false,
                        onToggle: () => {},
                      },
                    )}
                    ${renderStreamGroup([{ kind: "stream", key: "stream", text: code, startedAt: 1_000, isStreaming: true }])}
                    ${renderStreamGroup([{ kind: "reading-indicator", key: "working", startedAt: 1_000 }])}
                  </div>
                `,
                container,
              );
              await new Promise<void>((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
              });

              const own = container.querySelector('[data-chat-row-key="own"] .chat-bubble');
              expect(own).not.toBeNull();
              const edge = (element: Element) => {
                const rect = element.getBoundingClientRect();
                return direction === "rtl" ? -rect.left : rect.right;
              };
              const boundary = edge(own!);
              const ownName = container.querySelector(
                '[data-chat-row-key="own"] .chat-sender-name',
              );
              expect(ownName).not.toBeNull();
              expect(Math.abs(edge(ownName!) - boundary)).toBeLessThanOrEqual(1);
              const context = `${width}/${theme}/${direct ? "direct" : "shared"}/${direction}/${mode}`;
              const leftGroups = container.querySelectorAll(
                '.chat-group:not([data-chat-row-key="own"])',
              );
              expect(leftGroups.length).toBe(fixtures.length + 3);
              for (const left of leftGroups) {
                const column = left.querySelector(".chat-group-messages")!;
                expect(
                  fullWidth && !left.classList.contains("chat-group--peer")
                    ? Math.abs(edge(column) - boundary)
                    : edge(column) - boundary,
                  `${context}: ${left.getAttribute("data-chat-row-key")} column`,
                ).toBeLessThanOrEqual(1);
                for (const block of left.querySelectorAll(
                  ".chat-bubble, .code-block-viewport, .markdown-table__viewport, .chat-message-images, .chat-assistant-attachment-card, .chat-activity-group, .chat-tool-msg-summary, .chat-tool-msg-body, .chat-reply-attribution",
                )) {
                  expect(
                    edge(block) - boundary,
                    `${context}: ${block.className}`,
                  ).toBeLessThanOrEqual(1);
                }
              }
              for (const [key, selector] of [
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
                [
                  "summary",
                  '.chat-work-group > .chat-activity-group__summary[aria-expanded="false"]',
                ],
                ["stream", ".code-block-wrapper"],
                ["working", ".chat-reading-indicator"],
              ] as const) {
                const fixture = container.querySelector(`[data-chat-row-key="${key}"]`)!;
                const block = fixture.querySelector(selector);
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
                const images = [
                  ...container.querySelectorAll<HTMLImageElement>(
                    `[data-chat-row-key="${key}"] img.chat-message-image`,
                  ),
                ];
                expect(images.length, `${context}: ${key} image count`).toBe(count);
                await expect
                  .poll(() =>
                    images.every((element) => element.complete && element.naturalWidth > 0),
                  )
                  .toBe(true);
              }
              for (const selector of [".code-block-wrapper", ".markdown-table"]) {
                const block = container.querySelector(selector)!;
                const viewport = [...block.querySelectorAll<HTMLElement>("*")].find(
                  (element) =>
                    element.scrollWidth > element.clientWidth &&
                    ["auto", "scroll"].includes(getComputedStyle(element).overflowX),
                );
                expect(viewport, `${context}: ${selector} internal scroll`).toBeDefined();
                viewport!.scrollLeft = getComputedStyle(viewport!).direction === "rtl" ? -64 : 64;
                expect(Math.abs(viewport!.scrollLeft)).toBeGreaterThan(0);
              }
              const thread = container.querySelector<HTMLElement>(".chat-thread")!;
              expect(
                thread.scrollWidth - thread.clientWidth,
                `${context}: thread overflow`,
              ).toBeLessThanOrEqual(1);
            }
          }
        }
      });
    }
  }
});
