import { beforeAll, describe, expect, it } from "vitest";
import { MarkdownDomReconciler } from "../lib/markdown-dom-reconciler.ts";
import { prepareMessageMarkdown } from "../pages/chat/components/chat-message-text-preparation.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { toStreamingMarkdownDomParts } from "./markdown-live.ts";
import type { MarkdownRenderOptions } from "./markdown-render-options.ts";
import transcriptCorpus from "./markdown-transcript-corpus.json" with { type: "json" };
import { toSanitizedMarkdownHtml } from "./markdown.ts";

type SecurityCase = { name: string; source: string; options?: MarkdownRenderOptions };
function samples(
  group: string,
  rows: (string | [string, MarkdownRenderOptions])[],
): SecurityCase[] {
  return rows.map((value, index) => {
    const sample =
      typeof value === "string" ? { source: value } : { source: value[0], options: value[1] };
    return { name: `${group} ${index}: ${sample.source.slice(0, 40)}`, ...sample };
  });
}

// Exact payloads from DOMPurify 3.4.17 (the installed version), covering its
// historical mutation-XSS, namespace confusion, and URI-obfuscation regressions:
// https://github.com/cure53/DOMPurify/blob/3.4.17/test/fixtures/expect.mjs
// Upstream's default-config expected HTML is intentionally not our oracle:
// Markdown has a narrower HTML policy and must retain its own one-shot output.
const domPurifyCases = samples("domPurifyCases", [
  '<listing>&lt;img onerror="alert(1);//" src=x&gt;<t t></listing>',
  "<img src=x id/=' onerror=alert(1)//'>",
  '<a href="\u0001java\u0003script:alert(1)">@shafigullin<a>',
  "<math></p><textarea><mi><style></textarea><img src=x onerror=alert(1)></mi></math>",
  "<svg></p><title><template><style></title><img src=x onerror=alert(1)>",
  '<svg><p><style><g title="</style><img src=x onerror=alert(1)>">',
  '<svg><foreignobject><p><style><p title="</style><iframe onload&#x3d;alert(1)<!--"></style>',
  '<math><annotation-xml encoding="text/html"><p><style><p title="</style><iframe onload&#x3d;alert(1)<!--"></style>',
  "<form><math><mtext></form><form><mglyph><style><img src=x onerror=alert(1)>",
  "<math><mtext><table><mglyph><style><math href=javascript:alert(1)>CLICKME</math>",
  '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=alert(1)&gt;">',
  '<form><math><mtext></form><form><mglyph><svg><mtext><style><path id="</style><img onerror=alert(1) src>">',
  '<math><mtext><table><mglyph><svg><mtext><style><path id="</style><img onerror=alert(1) src>">',
  'a<svg><xss><desc><noscript>&lt;/noscript>&lt;/desc>&lt;s>&lt/s>&lt;style>&lt;a title="&lt;/style>&lt;img src onerror=alert(1)>">',
  "<math><mtext><option><FAKEFAKE><option></option><mglyph><svg><mtext><style><a title=\"</style><img src='#' onerror='alert(1)'>\">",
]);

const streamingCases = samples("streamingCases", [
  "<img src=x onerror=alert(1)>",
  "[one](javascript:alert(1)) [two](jav&#x61;script:alert(1)) [three](vbscript:msgbox(1)) [four](data:text/html;base64,PHNjcmlwdD4=) ![image](javascript:alert(1))",
  '[unfinished](javascript:alert(1) "<img src=x onerror=alert(1)>',
  '<details><summary title="<img src=x onerror=',
  "<!-- <img src=x onerror=alert(1)>",
  "```html\n<img src=x onerror=alert(1)>\n<script>alert(1)</script>",
  "> - ~~~html\n>   <svg onload=alert(1)>\n>   <iframe srcdoc='<script>alert(1)</script>'>",
  '<script>alert(1)</script><style>body{display:none}</style><iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<progress value="25" max="100" onmouseover="alert(1)" style="color:red"></progress>',
  '![safe](data:image/png;base64,iVBORw0KGgo=) [safe](https://example.com) <img src="data:text/html,<script>alert(1)</script>" onerror=alert(1)>',
]);

const directDomCases = samples("directDomCases", [
  '[label](https://example.com "--!> ]> </script> </textarea>")',
  "```x--!>\nconst value = '<img src=x onerror=alert(1)>';\n```",
  ["[file](/Users/example/a%00b.txt)", { fileLinks: true }],
  ["[file](/Users/example/a%0Db.txt)", { fileLinks: true }],
  ["[file](/Users/example/a%0D%0Ab.txt)", { fileLinks: true }],
  "https://github.com/example/repo/blob/main/a%0Db.ts",
  "https://github.com/example/repo/blob/main/a%0D%0Ab.ts",
  "- **strong**\n  - [incomplete",
  ['[site](https://example.com/path?q=one&next=two "--!> </script>")', { linkFavicons: true }],
]);

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

    for (const schedule of [{ name: "static", ends: [] }, ...splitSchedules(sample.source)]) {
      const key = `security:${sample.name}:${schedule.name}`;
      const container = document.body.appendChild(document.createElement("div"));
      // Production supplies session-title registration. These fixtures have no
      // dynamic session-title labels.
      const reconciler = new MarkdownDomReconciler(container, () => () => {});
      try {
        for (const end of schedule.ends) {
          const source = sample.source.slice(0, end);
          if (reconciler.canPreview(key, source)) {
            reconciler.preview(source);
            expect(unsafeDom(container), `${key}, plain preview ${end}`).toEqual([]);
          }
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
        if (schedule.name === "static") {
          expect(completed.parts().every((part) => typeof part === "string")).toBe(true);
        }
        reconciler.update(completed.messageKey, completed.source, completed.parts());
        expect(unsafeDom(container), `${key}, completion`).toEqual([]);
        expect(serializedContent(container), `${key}, completion`).toBe(expected);
      } finally {
        reconciler.dispose();
        container.remove();
      }
    }
  });
});
