import { beforeAll, describe, expect, it } from "vitest";
import { MarkdownDomReconciler } from "../lib/markdown-dom-reconciler.ts";
import { prepareMessageMarkdown } from "../pages/chat/components/chat-message-text-preparation.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import type { MarkdownRenderOptions } from "./markdown-render-options.ts";
import transcriptCorpus from "./markdown-transcript-corpus.json" with { type: "json" };
import { toSanitizedMarkdownHtml, toStreamingMarkdownDomParts } from "./markdown.ts";

type SecurityCase = { name: string; source: string; options?: MarkdownRenderOptions };

// Exact payloads from DOMPurify 3.4.17 (the installed version), covering its
// historical mutation-XSS, namespace confusion, and URI-obfuscation regressions:
// https://github.com/cure53/DOMPurify/blob/3.4.17/test/fixtures/expect.mjs
// Upstream's default-config expected HTML is intentionally not our oracle:
// Markdown has a narrower HTML policy and must retain its own one-shot output.
const domPurifyCases: SecurityCase[] = [
  {
    name: "mXSS Variation I",
    source: '<listing>&lt;img onerror="alert(1);//" src=x&gt;<t t></listing>',
  },
  { name: "mXSS Variation II", source: "<img src=x id/=' onerror=alert(1)//'>" },
  {
    name: "Low-range-ASCII obfuscated JavaScript URI",
    source: '<a href="\u0001java\u0003script:alert(1)">@shafigullin<a>',
  },
  {
    name: "MathML textarea mutation",
    source: "<math></p><textarea><mi><style></textarea><img src=x onerror=alert(1)></mi></math>",
  },
  {
    name: "SVG template mutation",
    source: "<svg></p><title><template><style></title><img src=x onerror=alert(1)>",
  },
  {
    name: "Attribute-based mXSS 1/3",
    source: '<svg><p><style><g title="</style><img src=x onerror=alert(1)>">',
  },
  {
    name: "Attribute-based mXSS 2/3",
    source:
      '<svg><foreignobject><p><style><p title="</style><iframe onload&#x3d;alert(1)<!--"></style>',
  },
  {
    name: "Attribute-based mXSS 3/3",
    source:
      '<math><annotation-xml encoding="text/html"><p><style><p title="</style><iframe onload&#x3d;alert(1)<!--"></style>',
  },
  {
    name: "Nesting-based mXSS 1/5",
    source: "<form><math><mtext></form><form><mglyph><style><img src=x onerror=alert(1)>",
  },
  {
    name: "Nesting-based mXSS 2/5",
    source: "<math><mtext><table><mglyph><style><math href=javascript:alert(1)>CLICKME</math>",
  },
  {
    name: "Nesting-based mXSS 3/5",
    source:
      '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=alert(1)&gt;">',
  },
  {
    name: "Nesting-based mXSS 4/5",
    source:
      '<form><math><mtext></form><form><mglyph><svg><mtext><style><path id="</style><img onerror=alert(1) src>">',
  },
  {
    name: "Nesting-based mXSS 5/5",
    source:
      '<math><mtext><table><mglyph><svg><mtext><style><path id="</style><img onerror=alert(1) src>">',
  },
  {
    name: "Fake-element namespace confusion 1/2",
    source:
      'a<svg><xss><desc><noscript>&lt;/noscript>&lt;/desc>&lt;s>&lt/s>&lt;style>&lt;a title="&lt;/style>&lt;img src onerror=alert(1)>">',
  },
  {
    name: "Fake-element namespace confusion 2/2",
    source:
      "<math><mtext><option><FAKEFAKE><option></option><mglyph><svg><mtext><style><a title=\"</style><img src='#' onerror='alert(1)'>\">",
  },
];

const streamingCases: SecurityCase[] = [
  { name: "split image handler", source: "<img src=x onerror=alert(1)>" },
  {
    name: "unsafe Markdown destinations and entity obfuscation",
    source:
      "[one](javascript:alert(1)) [two](jav&#x61;script:alert(1)) [three](vbscript:msgbox(1)) [four](data:text/html;base64,PHNjcmlwdD4=) ![image](javascript:alert(1))",
  },
  {
    name: "unfinished Markdown link and quoted HTML",
    source: '[unfinished](javascript:alert(1) "<img src=x onerror=alert(1)>',
  },
  { name: "unfinished HTML attribute", source: '<details><summary title="<img src=x onerror=' },
  { name: "unfinished HTML comment", source: "<!-- <img src=x onerror=alert(1)>" },
  {
    name: "unfinished backtick fence",
    source: "```html\n<img src=x onerror=alert(1)>\n<script>alert(1)</script>",
  },
  {
    name: "unfinished tilde fence in a container",
    source:
      "> - ~~~html\n>   <svg onload=alert(1)>\n>   <iframe srcdoc='<script>alert(1)</script>'>",
  },
  {
    name: "raw executable elements",
    source:
      '<script>alert(1)</script><style>body{display:none}</style><iframe srcdoc="<script>alert(1)</script>"></iframe>',
  },
  {
    name: "allowed progress tag with forbidden attributes",
    source: '<progress value="25" max="100" onmouseover="alert(1)" style="color:red"></progress>',
  },
  {
    name: "safe image and link beside an attack",
    source:
      '![safe](data:image/png;base64,iVBORw0KGgo=) [safe](https://example.com) <img src="data:text/html,<script>alert(1)</script>" onerror=alert(1)>',
  },
];

const directDomCases: SecurityCase[] = [
  {
    name: "Markdown title with XML mutation probes",
    source: '[label](https://example.com "--!> ]> </script> </textarea>")',
  },
  {
    name: "fence language with XML comment close",
    source: "```x--!>\nconst value = '<img src=x onerror=alert(1)>';\n```",
  },
  {
    name: "decoded NUL in a host-local file attribute",
    source: "[file](/Users/example/a%00b.txt)",
    options: { fileLinks: true },
  },
  {
    name: "decoded CR in a host-local file attribute",
    source: "[file](/Users/example/a%0Db.txt)",
    options: { fileLinks: true },
  },
  {
    name: "decoded CRLF in a host-local file attribute",
    source: "[file](/Users/example/a%0D%0Ab.txt)",
    options: { fileLinks: true },
  },
  {
    name: "decoded CR in a generated GitHub link label",
    source: "https://github.com/example/repo/blob/main/a%0Db.ts",
  },
  {
    name: "decoded CRLF in a generated GitHub link label",
    source: "https://github.com/example/repo/blob/main/a%0D%0Ab.ts",
  },
  {
    name: "nested tight list after an inline closing token",
    source: "- **strong**\n  - [incomplete",
  },
  {
    name: "generated favicon beside a hostile Markdown title",
    source: '[site](https://example.com/path?q=one&next=two "--!> </script>")',
    options: { linkFavicons: true },
  },
];

function splitSchedules(source: string): { name: string; ends: number[] }[] {
  const boundaries = new Set([source.length]);
  // Include both sides of syntax tokens, especially the on|error and java|script
  // boundaries that can turn a previously harmless partial token executable.
  const tokens = /on[a-z]+\s*=|(?:java|vb)script:|data:|<!--|-->|[<>&"'`=()[\]]/giu;
  for (const match of source.matchAll(tokens)) {
    for (let offset = 0; offset <= match[0].length; offset++) {
      if (match.index + offset > 0) {
        boundaries.add(match.index + offset);
      }
    }
  }
  const schedules = [
    { name: "syntax boundaries", ends: [...boundaries].toSorted((a, b) => a - b) },
  ];
  for (const seed of [0x17, 0x51, 0x203, 0x771, 0x1103]) {
    let state = seed;
    const ends: number[] = [];
    for (let end = 0; end < source.length;) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      end = Math.min(source.length, end + 1 + (state % 64));
      ends.push(end);
    }
    schedules.push({ name: `seed ${seed}`, ends });
  }
  return schedules;
}

function unsafeDom(root: ParentNode): string[] {
  const problems: string[] = [];
  for (const element of root.querySelectorAll("*")) {
    const tag = element.localName;
    if (
      element.namespaceURI !== "http://www.w3.org/1999/xhtml" ||
      /^(?:script|style|iframe|object|embed|link|meta|base|svg|math|template|form)$/u.test(tag)
    ) {
      problems.push(`forbidden element ${tag} in ${element.namespaceURI}`);
    }
    for (const attribute of element.attributes) {
      const name = attribute.name.toLowerCase();
      if (/^on|^(?:style|srcdoc|xmlns)(?::|$)/u.test(name)) {
        problems.push(`forbidden attribute ${tag}.${name}`);
      }
      if (/^(?:href|src|xlink:href|action|formaction|poster|background)$/u.test(name)) {
        const normalized = attribute.value.replace(/[\s\p{Cc}]/gu, "").toLowerCase();
        if (
          /^(?:javascript|vbscript):/u.test(normalized) ||
          (normalized.startsWith("data:") && !(tag === "img" && name === "src"))
        ) {
          problems.push(`forbidden URL ${tag}.${name}=${attribute.value}`);
        }
        if (tag === "a" && name === "href") {
          const url = URL.parse(attribute.value, document.baseURI);
          if (!url || !["http:", "https:", "mailto:"].includes(url.protocol)) {
            problems.push(`forbidden link ${attribute.value}`);
          }
        }
      }
    }
  }
  return problems;
}

function serializedContent(root: HTMLElement): string {
  const copy = document.createElement("div");
  copy.append(...Array.from(root.childNodes, (node) => node.cloneNode(true)));
  const walker = document.createTreeWalker(copy, NodeFilter.SHOW_COMMENT);
  const markers: Node[] = [];
  for (let marker = walker.nextNode(); marker; marker = walker.nextNode()) {
    if (marker.nodeValue === "") {
      markers.push(marker);
    }
  }
  for (const marker of markers) {
    marker.parentNode?.removeChild(marker);
  }
  return copy.innerHTML;
}

beforeAll(async () => {
  // The asynchronous highlighter must settle before taking the one-shot oracle.
  await waitForSolid(() =>
    expect(toSanitizedMarkdownHtml("```ts\nconst ready = true;\n```")).toContain("hljs-keyword"),
  );
});

describe("streaming Markdown sanitization at the live DOM boundary", () => {
  // SAFETY: the checked-in corpus options use the MarkdownRenderOptions schema.
  const corpusCases = transcriptCorpus as readonly SecurityCase[];
  const cases: SecurityCase[] = [
    ...corpusCases,
    ...directDomCases,
    ...[...domPurifyCases, ...streamingCases].flatMap((sample) =>
      [false, true].map((progressBars) => ({
        name: `${sample.name} / progress=${progressBars}`,
        // Exercise both a retained prefix and mutable tail around the payload.
        source: `Before **safe**.\n\n${sample.source}\n\nAfter **safe**.`,
        options: { progressBars, remoteImages: true },
      })),
    ),
  ];

  it.each(cases)("keeps every delta safe and finalizes byte-identically: $name", (sample) => {
    const reference = document.createElement("div");
    reference.innerHTML = toSanitizedMarkdownHtml(sample.source, sample.options);
    const expected = serializedContent(reference);
    expect(unsafeDom(reference)).toEqual([]);

    const staticContainer = document.body.appendChild(document.createElement("div"));
    const staticReconciler = new MarkdownDomReconciler(staticContainer, () => () => {});
    try {
      const settled = prepareMessageMarkdown(
        sample.source,
        `security:${sample.name}:static`,
        { role: "assistant", isStreaming: false },
        sample.options ?? {},
      );
      expect(settled.parts.every((part) => typeof part === "string")).toBe(true);
      staticReconciler.update(settled.messageKey, settled.source, settled.parts);
      expect(unsafeDom(staticContainer), `${sample.name}, static`).toEqual([]);
      expect(serializedContent(staticContainer), `${sample.name}, static`).toBe(expected);
    } finally {
      staticReconciler.dispose();
      staticContainer.remove();
    }

    for (const schedule of splitSchedules(sample.source)) {
      const key = `security:${sample.name}:${schedule.name}`;
      const container = document.body.appendChild(document.createElement("div"));
      // Production supplies session-title registration. These fixtures have no
      // dynamic session-title labels.
      const reconciler = new MarkdownDomReconciler(container, () => () => {});
      try {
        for (const end of schedule.ends) {
          const source = sample.source.slice(0, end);
          reconciler.update(key, source, toStreamingMarkdownDomParts(source, sample.options, key));
          expect(unsafeDom(container), `${key}, offset ${end}`).toEqual([]);
        }
        // Completion changes repair/highlighting semantics. Use the real chat
        // caller instead of pretending its last streaming delta is the final DOM.
        const completed = prepareMessageMarkdown(
          sample.source,
          key,
          { role: "assistant", isStreaming: false },
          sample.options ?? {},
        );
        reconciler.update(completed.messageKey, completed.source, completed.parts);
        expect(unsafeDom(container), `${key}, completion`).toEqual([]);
        expect(serializedContent(container), `${key}, completion`).toBe(expected);
      } finally {
        reconciler.dispose();
        container.remove();
      }
    }
  });
});
