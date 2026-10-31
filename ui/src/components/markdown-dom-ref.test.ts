import { createSignal, flush } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import type { ChatRowDisplayFacts } from "../lib/chat/row-display-facts.ts";
import { MarkdownDomReconciler } from "../lib/markdown-dom-reconciler.ts";
import { prepareMessageMarkdown } from "../pages/chat/components/chat-message-text-preparation.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { renderSolidRef } from "../test-helpers/render-solid-ref.ts";
import { createMarkdownRef } from "./markdown-dom-ref.ts";
import { updateLinkReaderDisplay } from "./markdown-link-display.ts";
import { toStreamingMarkdownDomParts } from "./markdown-live.ts";
import {
  partitionMarkdownHtml,
  prewarmSanitizedMarkdown,
  toSanitizedMarkdownContent,
  toSanitizedMarkdownHtml,
} from "./markdown.ts";

it("consumes prepared DOM once and can prewarm another visible mount", () => {
  const source = 'idle-cache-paragraph <img src="x" onerror="alert(1)">';
  const html = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML")!;
  let parses = 0;
  Object.defineProperty(Element.prototype, "innerHTML", {
    ...html,
    set(value: string) {
      if (this instanceof HTMLTemplateElement && value.includes("idle-cache-paragraph")) {
        parses++;
      }
      html.set!.call(this, value);
    },
  });
  onTestFinished(() => {
    Object.defineProperty(Element.prototype, "innerHTML", html);
  });
  expect(prewarmSanitizedMarkdown(source, {})).toBe(true);
  expect(prewarmSanitizedMarkdown(source, {})).toBe(false);
  const cached = toSanitizedMarkdownContent(source);
  expect(typeof cached).not.toBe("string");
  const view = renderSolidRef(() => createMarkdownRef(() => ({ content: cached })), {
    targetElement: document.createElement("div"),
  });
  expect(view.container.querySelector("[onerror]")).toBeNull();
  expect(parses).toBe(0);
  const reused = toSanitizedMarkdownContent(source);
  expect(reused).toBe(toSanitizedMarkdownHtml(source));
  const second = renderSolidRef(() => createMarkdownRef(() => ({ content: reused })), {
    targetElement: document.createElement("div"),
  });
  expect(second.container.innerHTML).toBe(view.container.innerHTML);
  expect(parses).toBe(1);
  // Ordinary remounts keep only HTML; an explicit prewarm rebuilds one fragment.
  expect(prewarmSanitizedMarkdown(source, {})).toBe(false);
  expect(prewarmSanitizedMarkdown(source, {}, "fragment")).toBe(true);
  expect(prewarmSanitizedMarkdown(source, {}, "fragment")).toBe(false);
  expect(parses).toBe(2);
  const preparedParses = parses;
  const rewarmed = toSanitizedMarkdownContent(source);
  expect(typeof rewarmed).not.toBe("string");
  const third = renderSolidRef(() => createMarkdownRef(() => ({ content: rewarmed })), {
    targetElement: document.createElement("div"),
  });
  expect(third.container.innerHTML).toBe(view.container.innerHTML);
  expect(third.container.querySelector("[onerror]")).toBeNull();
  expect(parses).toBe(preparedParses);
  expect(prewarmSanitizedMarkdown(source, { interactiveImages: true })).toBe(true);
  expect(prewarmSanitizedMarkdown("oversized ".repeat(6000), {})).toBe(false);
});

it("reuses sanitized HTML without retaining mounted DOM", () => {
  const marker = "html-only-visible-fragment";
  const source = `### ${marker}\n\n| State |\n| --- |\n| Ready |\n\n<img src="x" onerror="alert(1)"><script>alert(2)</script>`;
  const html = vi.spyOn(Element.prototype, "innerHTML", "set");
  onTestFinished(() => html.mockRestore());
  const parses = () =>
    html.mock.calls.filter(
      ([value], index) =>
        html.mock.contexts[index] instanceof HTMLTemplateElement && value.includes(marker),
    ).length;
  expect(prewarmSanitizedMarkdown(source, {}, "html")).toBe(true);
  expect(parses()).toBe(0);
  const mount = () => {
    const content = toSanitizedMarkdownContent(source);
    return renderSolidRef(() => createMarkdownRef(() => ({ content })), {
      targetElement: document.createElement("div"),
    });
  };

  const first = mount();
  expect(first.container.querySelector("h3")?.textContent).toBe(marker);
  expect(first.container.querySelector("td")?.textContent).toBe("Ready");
  expect(first.container.querySelector("script, [onerror]")).toBeNull();
  expect(parses()).toBe(1);
  first.container.querySelector("h3")!.textContent = "Mounted decoration";
  first.unmount();

  const second = mount();
  expect(second.container.querySelector("h3")?.textContent).toBe(marker);
  expect(second.container.querySelector("td")?.textContent).toBe("Ready");
  expect(second.container.querySelector("script, [onerror]")).toBeNull();
  expect(parses()).toBe(2);
});

it("bounds prepared DOM while keeping evicted HTML reusable", () => {
  const source = (index: number) => `bounded-idle-fragment-${index}`;
  for (let index = 0; index < 257; index++) {
    expect(prewarmSanitizedMarkdown(source(index), {})).toBe(true);
  }
  expect(prewarmSanitizedMarkdown(source(0), {}, "fragment")).toBe(true);
  expect(prewarmSanitizedMarkdown(source(256), {}, "fragment")).toBe(false);
  expect(prewarmSanitizedMarkdown(source(256), {}, "fragment")).toBe(false);
  for (let index = 1; index < 257; index++) {
    expect(prewarmSanitizedMarkdown(source(index), {}, "fragment")).toBe(true);
  }
  expect(prewarmSanitizedMarkdown(source(0), {}, "fragment")).toBe(true);
  expect(prewarmSanitizedMarkdown(source(256), {}, "fragment")).toBe(false);
  expect(toSanitizedMarkdownHtml(source(0))).toBe(`<p>${source(0)}</p>\n`);
  for (let index = 0; index < 64; index++) {
    prewarmSanitizedMarkdown(`near-first-${index}`, {}, index < 8 ? "cold-fragment" : "html");
  }
  expect(prewarmSanitizedMarkdown("near-first-0", {}, "fragment")).toBe(false);
  expect(prewarmSanitizedMarkdown("near-first-0", {}, "fragment")).toBe(false);
  expect(prewarmSanitizedMarkdown("near-first-63", {}, "fragment")).toBe(true);
  expect(prewarmSanitizedMarkdown("near-first-63", {}, "fragment")).toBe(false);
});

it("stops distant idle admission at the character budget without evicting nearby HTML", () => {
  const near = "nearby-before-large-idle-sweep";
  toSanitizedMarkdownHtml(near);
  const sources = Array.from(
    { length: 200 },
    (_, index) => `large-idle-${index} ${"plain text ".repeat(4000)}`,
  );
  for (const source of sources) {
    prewarmSanitizedMarkdown(source, {}, "idle-html");
  }
  expect(prewarmSanitizedMarkdown(near, {})).toBe(false);
  expect(toSanitizedMarkdownHtml(near)).toBe(`<p>${near}</p>\n`);
  const parse = vi.spyOn(DOMParser.prototype, "parseFromString");
  for (const source of sources) {
    toSanitizedMarkdownHtml(source);
  }
  expect(parse.mock.calls.length).toBeGreaterThan(0);
});

it("reuses fresh chat Markdown as sanitized HTML across mounts", () => {
  const marker = "chat-sanitized-fragment-first-mount";
  const source = `### ${marker}\n\n| State |\n| --- |\n| Ready |\n\n<img src="x" onerror="alert(1)"><script>alert(2)</script>`;
  const html = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML")!;
  let parses = 0;
  Object.defineProperty(Element.prototype, "innerHTML", {
    ...html,
    set(value: string) {
      if (this instanceof HTMLTemplateElement && value.includes(marker)) {
        parses++;
      }
      html.set!.call(this, value);
    },
  });
  onTestFinished(() => {
    Object.defineProperty(Element.prototype, "innerHTML", html);
  });
  const prepare = () =>
    prepareMessageMarkdown(
      source,
      marker,
      { role: "assistant", isStreaming: false },
      {},
    ).parts()[0];
  const fresh = prepare();
  expect(typeof fresh).toBe("string");
  const first = renderSolidRef(() => createMarkdownRef(() => ({ content: fresh })), {
    targetElement: document.createElement("div"),
  });
  expect(first.container.querySelector("h3")?.textContent).toBe(marker);
  expect(first.container.querySelector("td")?.textContent).toBe("Ready");
  expect(first.container.querySelector("script, [onerror]")).toBeNull();
  expect(parses).toBe(1);

  const cached = prepare();
  expect(cached).toEqual(fresh);
  const second = renderSolidRef(() => createMarkdownRef(() => ({ content: cached })), {
    targetElement: document.createElement("div"),
  });
  expect(second.container.innerHTML).toBe(first.container.innerHTML);
  expect(parses).toBe(2);
  expect(toSanitizedMarkdownHtml(source)).toBe(typeof fresh === "string" ? fresh : fresh.html);
});

it("isolates ordinary and progress policies for fragment and HTML callers", () => {
  const source =
    '<progress value="2" max="5">fragment-policy-progress</progress><img src="x" onerror="alert(1)"><a href="javascript:alert(2)">Link</a>';
  expect(prewarmSanitizedMarkdown(source, { progressBars: true })).toBe(true);
  expect(prewarmSanitizedMarkdown(source, {})).toBe(true);
  const progress = toSanitizedMarkdownContent(source, { progressBars: true });
  const ordinary = toSanitizedMarkdownContent(source);
  if (typeof progress === "string" || typeof ordinary === "string") {
    throw new Error("Fresh Markdown must retain its sanitized fragment");
  }
  expect(progress.fragment.querySelector("progress")?.getAttribute("value")).toBe("2");
  expect(ordinary.fragment.querySelector("progress")).toBeNull();
  for (const fragment of [progress.fragment, ordinary.fragment]) {
    expect(fragment.querySelector("script, [onerror], [href]")).toBeNull();
  }

  const ordinaryHtml = toSanitizedMarkdownHtml(`${source} ordinary string`);
  const progressHtml = toSanitizedMarkdownHtml(`${source} progress string`, { progressBars: true });
  expect(typeof ordinaryHtml).toBe("string");
  expect(ordinaryHtml).not.toContain("<progress");
  expect(typeof progressHtml).toBe("string");
  expect(progressHtml).toContain('<progress value="2" max="5">');
  expect(toSanitizedMarkdownContent(source)).toBe(ordinary.html);
  expect(toSanitizedMarkdownContent(source, { progressBars: true })).toBe(progress.html);
});

it("mounts settled Markdown from one parse and preserves encoded carriage returns", () => {
  const content =
    '<p title="settled-parse&#13;title">settled-parse&#13;text</p><ul><li>settled-parse item</li></ul>';
  const html = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML")!;
  let parses = 0;
  Object.defineProperty(Element.prototype, "innerHTML", {
    ...html,
    set(value: string) {
      if (this instanceof HTMLTemplateElement && value.includes("settled-parse")) {
        parses++;
      }
      html.set!.call(this, value);
    },
  });
  onTestFinished(() => {
    Object.defineProperty(Element.prototype, "innerHTML", html);
  });
  const view = renderSolidRef(() => createMarkdownRef(() => ({ content })), {
    targetElement: document.createElement("div"),
  });
  expect(view.container.querySelector("p")?.textContent).toBe("settled-parse\rtext");
  expect(view.container.querySelector("p")?.getAttribute("title")).toBe("settled-parse\rtitle");
  expect(view.container.querySelector("li")?.textContent).toBe("settled-parse item");
  expect(parses).toBe(1);
});

it("publishes only differing PR facts and excludes query-bearing URLs from the cache", () => {
  const pr = "https://github.com/example/project/pull/42";
  const queryPr = `${pr}?access_token=synthetic-fixture`;
  let facts: ChatRowDisplayFacts = {
    links: {
      [`pr:${pr}`]: { title: "Synthetic change", badge: { label: "Open", tone: "positive" } },
    },
  };
  const write = vi.fn((update: Partial<ChatRowDisplayFacts>) => {
    facts = { ...facts, ...update };
  });
  const display = { read: () => ({ scope: "cached-markdown", facts }), write };
  const html = toSanitizedMarkdownHtml(`${pr}\n\n${queryPr}`);
  const view = renderSolidRef(
    () =>
      createMarkdownRef(
        () => ({ content: html }),
        () => display,
      ),
    {
      targetElement: document.createElement("div"),
    },
  );
  onTestFinished(() => view.unmount());
  const link = view.container.querySelector<HTMLAnchorElement>("a.markdown-github-item")!;
  expect(link.getAttribute("aria-description")).toBe("Open");
  expect(link.dataset.linkReaderTone).toBe("positive");
  const queryLink =
    view.container.querySelectorAll<HTMLAnchorElement>("a.markdown-github-item")[1]!;
  expect(queryLink.getAttribute("aria-description")).toBeNull();
  const observer = new MutationObserver(() => undefined);
  observer.observe(view.container, { attributes: true, childList: true, subtree: true });
  try {
    updateLinkReaderDisplay(link, {
      url: pr,
      title: "Synthetic change",
      badge: { label: "Open", tone: "positive" },
    });
    expect(observer.takeRecords()).toEqual([]);
    expect(write).not.toHaveBeenCalled();
    updateLinkReaderDisplay(link, {
      url: pr,
      title: "Synthetic change",
      badge: { label: "Merged", tone: "accent" },
    });
    expect(link.dataset.linkReaderTone).toBe("accent");
    expect(facts.links?.[`pr:${pr}`]?.badge).toEqual({ label: "Merged", tone: "accent" });
    expect(write).toHaveBeenCalledOnce();
    updateLinkReaderDisplay(queryLink, {
      url: queryPr,
      title: "Query-specific preview",
      badge: { label: "Closed", tone: "neutral" },
    });
    expect(write).toHaveBeenCalledOnce();
    expect(Object.keys(facts.links ?? {})).toEqual([`pr:${pr}`]);
  } finally {
    observer.disconnect();
  }
});

it("commits Markdown before onUpdate and retires a replaced island", () => {
  const container = document.body.appendChild(document.createElement("div"));
  const [html, setHtml] = createSignal('<a href="#first">First</a>');
  const onUpdate = vi.fn(() => container.textContent);
  let bind!: (element: ParentNode) => void;
  const view = renderSolidRef(
    () => (bind = createMarkdownRef(() => ({ content: html(), onUpdate }))),
    { container, targetElement: document.createElement("div") },
  );
  onTestFinished(() => container.remove());
  expect(onUpdate).toHaveLastReturnedWith("First");
  const original = view.getByRole("link", { name: "First" });
  const replacement = container.appendChild(document.createElement("section"));
  bind(replacement);
  setHtml('<a href="#second">Second</a>');
  flush();
  expect(onUpdate).toHaveLastReturnedWith("Second");
  expect(original.isConnected).toBe(false);
  const current = view.getByRole("link", { name: "Second" });
  expect(replacement.contains(current)).toBe(true);

  view.unmount();
  expect(current).toMatchObject({ isConnected: false });
  expect(replacement.childNodes).toHaveLength(0);
});

it("keeps reusable prepared Markdown isolated from mounted decorations", () => {
  const fragment = document.createDocumentFragment();
  const paragraph = document.createElement("p");
  paragraph.textContent = "Prepared paragraph";
  const list = document.createElement("ul");
  list.innerHTML = "<li>Prepared item</li>";
  fragment.append(paragraph, list);
  const content = { html: paragraph.outerHTML + list.outerHTML, fragment };
  const first = renderSolidRef(() => createMarkdownRef(() => ({ content })), {
    targetElement: document.createElement("div"),
  });
  first.container.querySelector("p")!.textContent = "Mounted decoration";
  const second = renderSolidRef(() => createMarkdownRef(() => ({ content })), {
    targetElement: document.createElement("div"),
  });
  expect(second.container.querySelector("p")?.textContent).toBe("Prepared paragraph");
  expect(second.container.querySelector("li")?.textContent).toBe("Prepared item");
  expect(fragment.firstChild).toBe(paragraph);
  expect(fragment.lastChild).toBe(list);
  expect(paragraph.textContent).toBe("Prepared paragraph");
});

it("mounts prepared blocks without per-block templates and registers root and nested titles", () => {
  const template = document.createElement("template");
  template.innerHTML =
    '<a class="markdown-session-link">Root title</a><p><a data-session-href="nested">Nested title</a></p><pre>Code</pre>';
  const content = { html: template.innerHTML, fragment: template.content };
  const create = vi.spyOn(document, "createElement");
  const release = vi.fn();
  const register = vi.fn((_target: HTMLElement, _label: HTMLElement) => release);
  const target = document.createElement("div");
  const reconciler = new MarkdownDomReconciler(target, register);
  onTestFinished(() => reconciler.dispose());

  reconciler.updateHtml(content);

  // One private parse serves every opaque block; their insertion needs no template.
  expect(create.mock.calls.filter(([tag]) => tag === "template")).toHaveLength(1);
  expect(register.mock.calls.map(([element]) => element.textContent)).toEqual([
    "Root title",
    "Nested title",
  ]);
  expect(target.textContent).toBe("Root titleNested titleCode");
  expect(content.fragment.textContent).toBe(target.textContent);
  reconciler.dispose();
  expect(release).toHaveBeenCalledTimes(2);
});

it.each([
  ["paragraph", "A growing reply", "p"],
  ["list", "- First item\n- Growing item", "ul"],
  ["code fence", "```text\nA growing block", "pre"],
])("retains every node across 12 %s updates", (_label, initial, selector) => {
  const [source, setSource] = createSignal(initial);
  const { container: target } = mountSolid(() => {
    const fragment = document.createDocumentFragment();
    createMarkdownRef(() => ({
      content: {
        messageKey: "stream",
        source: source(),
        parts: toStreamingMarkdownDomParts(source()),
      },
    }))(fragment);
    return Array.from(fragment.childNodes);
  });
  const retained = target.querySelector(selector);
  expect(retained).not.toBeNull();
  const observer = new MutationObserver(() => {});
  observer.observe(target, { childList: true, subtree: true, characterData: true });
  onTestFinished(() => observer.disconnect());
  for (let index = 1; index <= 12; index++) {
    setSource(initial + " with more text".repeat(index));
    flush();
  }
  const mutations = observer.takeRecords();
  expect(target.querySelector(selector)).toBe(retained);
  expect(mutations.flatMap((mutation) => [...mutation.removedNodes])).toHaveLength(0);
  expect(retained?.textContent).toContain(" with more text".repeat(12));
  expect(mutations.some((mutation) => mutation.type === "characterData")).toBe(true);
});

it("retires retained media when the Solid owner unmounts", () => {
  const dispose = vi.fn();
  const setConnected = vi.fn();
  const target = document.createElement("div");
  const media = {
    prefix: "MEDIA",
    render: (_index: number, container: HTMLElement) => {
      container.textContent = "Attachment";
      return { dispose, setConnected };
    },
  };
  const read = () => ({ content: "<p>Before MEDIA0END after</p>", media });
  const view = renderSolidRef(() => createMarkdownRef(read), { targetElement: target });
  expect(target.textContent).toBe("Before Attachment after");
  expect(setConnected).toHaveBeenCalledWith(true);
  view.unmount();
  expect(dispose).toHaveBeenCalledOnce();
  expect(target.childNodes).toHaveLength(0);
});

it("retains external long-code decoration until the exact source changes", () => {
  const markup = (code: string, prose: string) =>
    `<div class="code-block-wrapper"><div class="code-block-viewport"><pre><code data-code-highlight="ts">${code}</code></pre></div></div><p>${prose}</p>`;
  const [html, setHtml] = createSignal(markup("before", "First"));
  const view = renderSolidRef(
    () => createMarkdownRef(() => ({ content: html(), incremental: true })),
    { targetElement: document.createElement("div") },
  );
  const code = view.container.querySelector("code")!;
  const wrapper = view.container.querySelector(".code-block-wrapper");
  expect([...code.childNodes].map((node) => node.nodeType)).toEqual([Node.TEXT_NODE]);
  const highlighted = document.createElement("span");
  highlighted.className = "hljs-keyword";
  highlighted.textContent = "before";
  code.replaceChildren(highlighted);
  setHtml(markup("before", "Unrelated prose"));
  flush();
  expect(view.container.querySelector("code")).toBe(code);
  expect(code.firstChild).toBe(highlighted);
  setHtml(markup("after", "Unrelated prose"));
  flush();
  expect(view.container.querySelector(".code-block-wrapper")).toBe(wrapper);
  expect(view.container.querySelector("code")).not.toBe(code);
  expect(code.isConnected).toBe(false);
  expect(view.container.querySelector("code")?.textContent).toBe("after");
});

it("hands a closed stream fence to the code owner and retains its decoration at completion", () => {
  const codeSource = "const value = 1;\n".repeat(400);
  const [source, setSource] = createSignal("```ts\n" + codeSource);
  const [streaming, setStreaming] = createSignal(true);
  const options = { codeBlockInteraction: "interactive" } as const;
  const view = renderSolidRef(
    () =>
      createMarkdownRef(() => ({
        content: {
          messageKey: "large-fence-stream",
          source: source(),
          parts: streaming()
            ? toStreamingMarkdownDomParts(source(), options, "large-fence-stream")
            : partitionMarkdownHtml(
                toSanitizedMarkdownHtml(source(), options),
                "large-fence-stream",
              ),
        },
      })),
    { targetElement: document.createElement("div") },
  );
  expect(view.container.querySelector("code[data-code-highlight]")).toBeNull();
  expect(view.container.querySelector("code")?.textContent).toBe(codeSource);
  setSource(source() + "```\n\nDone.");
  flush();
  const code = view.container.querySelector("code[data-code-highlight]")!;
  expect(code).not.toBeNull();
  const highlighted = document.createElement("span");
  highlighted.className = "hljs-keyword";
  highlighted.textContent = codeSource;
  code.replaceChildren(highlighted);
  setStreaming(false);
  flush();
  expect(view.container.querySelector("code[data-code-highlight]")).toBe(code);
  expect(code.firstChild).toBe(highlighted);
  expect(code.textContent).toBe(codeSource);
});
