import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createMemo, createSignal, onSettled, Show } from "solid-js";
import { markdownContentHtml } from "../lib/markdown-content.ts";
import { observeFontLoading } from "../lib/reactive/font-loading.ts";
import { i18nRevision } from "../lib/reactive/i18n.ts";
import { createLayoutMeasurement } from "../lib/reactive/layout-measurement.ts";
import { createMarkdownRef } from "./markdown-dom-ref.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";
import { removeProgressBars } from "./session-progress-card.ts";

export function ProgressCardMarkdown(props: {
  markdown?: string;
  omitProgress?: boolean;
  previewLines?: number;
  registerControls?: (read: () => HTMLElement[]) => () => void;
}) {
  const sanitized = createMemo(() => {
    i18nRevision();
    const html = props.markdown
      ? toSanitizedMarkdownHtml(props.markdown, {
          progressBars: true,
          ...(props.previewLines ? { codeBlockChrome: "none" } : {}),
        })
      : "";
    return props.omitProgress ? removeProgressBars(html) : html;
  });
  const container = document.createElement("div");
  container.className = "session-progress-card__markdown sidebar-markdown";
  const [layoutRevision, setLayoutRevision] = createSignal(0);
  const schedulePreview = createLayoutMeasurement(
    () => props.previewLines,
    () => () => setLayoutRevision((revision) => revision + 1),
    {
      targets: (lines) => (lines ? [container] : []),
      changeTiming: "sync",
    },
  );
  const markdown = createMarkdownRef(() => {
    layoutRevision();
    const lines = props.previewLines;
    return {
      content: sanitized(),
      prepareContent: lines
        ? (content) =>
            container.clientWidth
              ? fitMarkdownPreview(markdownContentHtml(content), container, lines)
              : ""
        : undefined,
    };
  });
  markdown(container);
  onSettled(() =>
    props.previewLines ? observeFontLoading(document.fonts, schedulePreview) : undefined,
  );
  // This dedicated island contains only the reconciler's foreign Markdown DOM.
  onSettled(() =>
    props.registerControls?.(() =>
      Array.from(container.querySelectorAll<HTMLElement>("a[href], button, summary, [tabindex]")),
    ),
  );
  return <Show when={props.markdown}>{container}</Show>;
}

/** Measure sanitized prefixes outside the reconciler; only the fitting prefix becomes output. */
function fitMarkdownPreview(html: string, container: HTMLElement, lines: number): string {
  const source = document.createElement("template");
  source.innerHTML = html;
  const probe = document.createElement("div");
  probe.className = container.className;
  probe.inert = true;
  Object.assign(probe.style, {
    position: "absolute",
    visibility: "hidden",
    width: `${container.getBoundingClientRect().width}px`,
  });
  container.after(probe);
  try {
    const limit = Number.parseFloat(getComputedStyle(container).lineHeight) * lines;
    const fits = () =>
      probe.getBoundingClientRect().height <= limit &&
      [probe, ...probe.getElementsByTagName("*")].every(
        (element) =>
          element.scrollWidth <= element.clientWidth &&
          element.scrollHeight <= element.clientHeight,
      );
    probe.append(source.content.cloneNode(true));
    if (fits()) {
      return html;
    }
    const texts: Text[] = [];
    const walker = document.createTreeWalker(source.content, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node instanceof Text) {
        texts.push(node);
      }
    }
    const range = document.createRange();
    range.setStart(source.content, 0);
    const prefix = (length: number) => {
      range.setEnd(source.content, 0);
      let remaining = length;
      if (remaining > 0) {
        for (const text of texts) {
          if (remaining <= text.length) {
            range.setEnd(text, truncateUtf16Safe(text.data, remaining).length);
            break;
          }
          remaining -= text.length;
        }
      }
      const fragment = range.cloneContents();
      let tail: Node = fragment;
      while (tail.lastChild) {
        tail = tail.lastChild;
      }
      if (tail instanceof Text) {
        tail.data = `${tail.data.trimEnd()}…`;
      } else {
        fragment.append("…");
      }
      probe.replaceChildren(fragment);
    };
    let low = 0;
    let high = texts.reduce((total, text) => total + text.length, 0);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      prefix(middle);
      if (fits()) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    prefix(low);
    return probe.innerHTML;
  } finally {
    probe.remove();
  }
}
