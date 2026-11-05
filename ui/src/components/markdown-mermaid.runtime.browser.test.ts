import { renderMermaidSvg } from "@openclaw/mermaid-renderer";
import { afterAll, expect, it } from "vitest";
import { parsePassiveSvg, renderSvg, theme } from "./markdown-mermaid.test-support.ts";

const swimlane =
  "swimlane-beta LR\n  subgraph Gateway\n    Admit[Admit]\n  end\n  subgraph Runtime\n    Execute[Execute]\n  end\n  Admit --> Execute";
const sandbox = "iframe[sandbox='allow-scripts'][srcdoc]";

function diagramNode(root: Element, label: string): Element {
  const text = Array.from(root.querySelectorAll("text")).find((node) =>
    node.textContent?.includes(label),
  );
  let node = text?.parentElement;
  while (node && node !== root) {
    if (node.querySelector(":scope > rect, :scope > circle, :scope > ellipse, :scope > polygon")) {
      return node;
    }
    node = node.parentElement;
  }
  throw new Error(`Missing diagram node: ${label}`);
}

afterAll(() => {
  window.dispatchEvent(new PageTransitionEvent("pagehide"));
  expect(document.querySelector(sandbox)).toBeNull();
});

it("renders multiline flowchart labels and both directions as a passive SVG image", async () => {
  const source = `flowchart LR
G["Gateway: channels, admission,<br/>approvals and lifecycle"]
W["Bounded warm executors:<br/>session loops and runtime processing"]
S["Canonical state owner:<br/>ordered, fenced commits"]
G <-->|Commands and compact events| W
W --> S
G --> S`;
  const svg = await renderMermaidSvg(source, theme);
  const root = parsePassiveSvg(svg);
  expect(root.localName).toBe("svg");
  expect(root.textContent).toContain("Gateway:");
  expect(root.textContent).toContain("lifecycle");
  expect(root.textContent).toContain("Commands");
  // Pele draws arrowheads as passive paths rather than SVG marker references.
  const bidirectional = Array.from(root.querySelectorAll("g")).find(
    (group) => group.querySelectorAll(":scope > path").length === 3,
  );
  expect(bidirectional).toBeDefined();
  expect(bidirectional!.querySelectorAll(':scope > path:not([fill="none"])')).toHaveLength(2);
  document.body.append(root);
  try {
    const gateway = diagramNode(root, "Gateway:");
    const box = gateway.querySelector("rect")!.getBoundingClientRect();
    const label = gateway.querySelector("text")!.getBoundingClientRect();
    expect(box.height).toBeGreaterThan(0);
    expect(Math.abs(label.top + label.bottom - box.top - box.bottom)).toBeLessThan(
      box.height * 0.2,
    );
  } finally {
    root.remove();
  }
  const frame = document.querySelector<HTMLIFrameElement>(sandbox);
  expect(frame).not.toBeNull();
  expect(frame?.contentDocument).toBeNull();
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    expect(image.naturalWidth).toBeGreaterThan(0);
    expect(image.naturalHeight).toBeGreaterThan(0);
    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 100;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0, 200, 100);
    // Exclude antialiasing at fractional SVG viewport edges. The interior
    // must not let the underlying chat show through expanded labels.
    const pixels = context.getImageData(1, 1, 198, 98).data;
    expect(pixels.every((value, index) => index % 4 !== 3 || value === 255)).toBe(true);
  } finally {
    URL.revokeObjectURL(url);
  }
});

it.each([
  [
    "architecture-beta\nservice gateway(server)[Gateway]\nservice runtime(server)[Runtime]\ngateway:R -- L:runtime",
    "Gateway",
  ],
  ['pie title Requests\n"Approved" : 70\n"Rejected" : 30', "Approved"],
  ["erDiagram\nREQUEST ||--o{ RESULT : produces", "REQUEST"],
  ["stateDiagram-v2\n[*] --> Ready\nReady --> Running\nRunning --> [*]", "Running"],
])("preserves diagram content for %s", async (source, label) => {
  const root = await renderSvg(source);
  expect(root.textContent).toContain(label);
  expect(root.querySelector("path,rect,line,polygon")).not.toBeNull();
});

it("keeps wide proportional-font labels inside their nodes", async () => {
  const label = "WWWWWWWWWWWWWWWWWWWW";
  const root = await renderSvg(`flowchart LR\nA["${label}"]`);
  document.body.append(root);
  try {
    const node = diagramNode(root, label);
    const shape = node.querySelector("rect")!.getBoundingClientRect();
    const text = node.querySelector("text")!.getBoundingClientRect();
    expect(text.width).toBeGreaterThan(0);
    expect(text.left).toBeGreaterThanOrEqual(shape.left);
    expect(text.right).toBeLessThanOrEqual(shape.right);
    expect(text.top).toBeGreaterThanOrEqual(shape.top);
    expect(text.bottom).toBeLessThanOrEqual(shape.bottom);
  } finally {
    root.remove();
  }
});

it("preserves quoted host font stacks in the standalone SVG", async () => {
  const family = '"Instrument Sans", Arial, Helvetica, "Segoe UI", Roboto, sans-serif';
  const root = parsePassiveSvg(
    await renderMermaidSvg("flowchart LR\nA[Quoted font] --> B[Ready]", {
      ...theme,
      fontFamily: family,
    }),
  );
  expect(root.querySelector("text")?.getAttribute("font-family")).toBe(family);
  expect(root.querySelector("text")?.getAttribute("font-size")).toBe("14px");
});

it("keeps concurrent diagram themes independent in the warm renderer", async () => {
  const secondTheme = { ...theme, background: "#ffffff", foreground: "#202020", darkMode: false };
  const results = await Promise.all([
    renderMermaidSvg("flowchart LR\nA[First] --> B[Diagram]", theme),
    renderMermaidSvg("flowchart LR\nA[Second] --> B[Diagram]", secondTheme),
  ]);
  for (const [index, currentTheme] of [theme, secondTheme].entries()) {
    const root = parsePassiveSvg(results[index]!);
    const fills = Array.from(root.querySelectorAll("[fill]"), (element) =>
      element.getAttribute("fill"),
    );
    expect(fills).toContain(currentTheme.background);
    expect(fills).toContain(currentTheme.foreground);
  }
});

it("preserves diagram-specific mindmap and swimlane layouts", async () => {
  const mindmap = await renderSvg(
    "mindmap\n  root((OpenClaw))\n    Gateway\n      Admission\n    Runtime\n      Execution",
  );
  const lanes = await renderSvg(swimlane);
  document.body.append(mindmap, lanes);
  try {
    const center = (node: Element) => {
      const bounds = node.getBoundingClientRect();
      return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    };
    const origin = center(diagramNode(mindmap, "OpenClaw"));
    const children = ["Gateway", "Runtime"].map((label) => center(diagramNode(mindmap, label)));
    // Balanced branches may run horizontally or vertically, but must straddle the root.
    expect(
      (children.some((point) => point.x < origin.x) &&
        children.some((point) => point.x > origin.x)) ||
        (children.some((point) => point.y < origin.y) &&
          children.some((point) => point.y > origin.y)),
    ).toBe(true);
    const gateway = diagramNode(lanes, "Gateway").getBoundingClientRect();
    const runtime = diagramNode(lanes, "Runtime").getBoundingClientRect();
    const admit = diagramNode(lanes, "Admit").getBoundingClientRect();
    const execute = diagramNode(lanes, "Execute").getBoundingClientRect();
    expect(gateway.bottom).toBeLessThanOrEqual(runtime.top);
    expect(admit.top).toBeGreaterThanOrEqual(gateway.top);
    expect(admit.bottom).toBeLessThanOrEqual(gateway.bottom);
    expect(execute.top).toBeGreaterThanOrEqual(runtime.top);
    expect(execute.bottom).toBeLessThanOrEqual(runtime.bottom);
  } finally {
    mindmap.remove();
    lanes.remove();
  }
});

it("enforces host source and edge limits despite source configuration, then recovers", async () => {
  await expect(renderMermaidSvg("x".repeat(20_001), theme)).rejects.toThrow(/characters/u);
  const source = `%%{init: {"maxEdges": 1000}}%%\nflowchart LR\n${Array.from({ length: 201 }, (_, index) => `A${index} --> A${index + 1}`).join("\n")}`;
  await expect(renderMermaidSvg(source, theme)).rejects.toThrow(/edge/iu);
  await expect(renderMermaidSvg("flowchart LR\nA -->", theme)).rejects.toThrow();
  const recovered = await renderSvg("flowchart LR\nA[Recovered] --> B[Ready]");
  expect(recovered.textContent).toContain("Recovered");
});

it("keeps source-provided image data out of the passive result", async () => {
  const image = btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
  );
  const source = `flowchart LR\nA@{ img: "data:image/svg+xml;base64,${image}", label: "Image" }`;
  const svg = await renderMermaidSvg(source, theme);
  expect(parsePassiveSvg(svg).textContent).toContain("Image");
  expect(svg).not.toContain("data:image");
});

it("keeps source links and CSS inside the sandbox and preserves safe diagram styles", async () => {
  const config = {
    securityLevel: "loose",
    htmlLabels: true,
    themeCSS: '@import url("https://example.invalid/mermaid.css"); body { opacity: 0 !important; }',
    dompurifyConfig: { ADD_TAGS: ["script", "image"], ADD_ATTR: ["onload"] },
  };
  const source = `%%{init: ${JSON.stringify(config)}}%%
flowchart LR
A[Styled] --> B[Link]
classDef default fill:#ffaa00,color:#112233;
click A "javascript:alert(1)"
click B "https://example.invalid/mermaid-link"`;
  const opacity = getComputedStyle(document.body).opacity;
  const svg = await renderMermaidSvg(source, theme);
  const root = parsePassiveSvg(svg);
  expect(root.textContent).toContain("Styled");
  expect(root.querySelector('[fill="#ffaa00"]')).not.toBeNull();
  expect(svg).not.toContain("example.invalid");
  expect(svg).not.toContain("javascript:");
  expect(getComputedStyle(document.body).opacity).toBe(opacity);

  // Class diagrams accept CSS functions; flowchart classDef grammar rejects them.
  const remote = await renderMermaidSvg(
    "classDiagram\nclass Remote:::remote\nclassDef remote fill:url(https://example.invalid/mermaid-paint.svg#paint)",
    theme,
  );
  expect(parsePassiveSvg(remote).textContent).toContain("Remote");
  expect(remote).not.toContain("example.invalid");
});

it("keeps untrusted alternatives inert and retires metadata when the source changes", async () => {
  await import("./markdown-mermaid.tsx");
  const element = document.createElement("openclaw-mermaid");
  document.body.append(element);
  const authored =
    "flowchart LR\naccTitle: Audit 🧪\naccDescr: Inspect <img src=x onerror=alert(1)> before allowing the request.\nA --> B";
  const cases = [
    { source: authored, title: "Audit 🧪", description: "Inspect", partial: true },
    {
      source: "flowchart LR\nA[No authored alternative] --> B",
      title: "Mermaid diagram",
      description: "",
    },
    {
      source: "flowchart LR\naccTitle: Approval order\nA --> B",
      title: "Approval order",
      description: "",
    },
    {
      source: "flowchart LR\naccDescr: Approval precedes execution.\nA --> B",
      title: "Mermaid diagram",
      description: "Approval precedes execution.",
    },
    { source: authored, title: "Audit 🧪", description: "Inspect", partial: true },
  ];
  try {
    for (const fixture of cases) {
      const oldUrl = element.querySelector(".preview img")?.getAttribute("src");
      element.source = fixture.source;
      await expect
        .poll(() => element.querySelector(".preview img")?.getAttribute("src"))
        .not.toBe(oldUrl);
      await expect
        .poll(() => element.querySelector<HTMLImageElement>(".preview img")?.alt)
        .toBe(fixture.title);
      const image = element.querySelector<HTMLImageElement>(".preview img")!;
      await image.decode();
      const description = document.getElementById(image.getAttribute("aria-describedby")!);
      if (fixture.description) {
        expect(description?.textContent).toContain(fixture.description);
        if (!fixture.partial) {
          expect(description?.textContent).toBe(fixture.description);
        }
        expect(description?.children).toHaveLength(0);
        expect(getComputedStyle(description!).display).toBe("none");
      } else {
        expect(description).toBeNull();
        expect(image.hasAttribute("aria-describedby")).toBe(false);
        expect(element.querySelector(".description")).toBeNull();
      }
      expect(element.querySelector(".preview svg, .preview script, .description img")).toBeNull();
      expect(image.src).toMatch(/^blob:/u);
    }
  } finally {
    element.remove();
  }
});
