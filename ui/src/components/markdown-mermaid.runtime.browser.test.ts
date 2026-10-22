import { renderMermaidSvg } from "@openclaw/mermaid-renderer";
import { afterAll, expect, it } from "vitest";
import { parsePassiveSvg, renderSvg, theme } from "./markdown-mermaid.test-support.ts";

const swimlane =
  "swimlane-beta LR\n  subgraph Gateway\n    Admit[Admit]\n  end\n  subgraph Runtime\n    Execute[Execute]\n  end\n  Admit --> Execute";
const sandbox = "iframe[sandbox='allow-scripts'][srcdoc]";

function parseTranslate(element: Element): { x: number; y: number } {
  const match = /^translate\(([-\d.]+), ([-\d.]+)\)$/u.exec(
    element.getAttribute("transform") ?? "",
  );
  if (!match) {
    throw new Error("Expected a translated Mermaid element.");
  }
  return { x: Number(match[1]), y: Number(match[2]) };
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
  expect(root.querySelector("[marker-start]")).not.toBeNull();
  expect(root.querySelector("[marker-end]")).not.toBeNull();
  document.body.append(root);
  try {
    const gateway = root.querySelector('g[id*="-flowchart-G-"]')!;
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
  const mindmapNodes = Array.from(
    mindmap.querySelectorAll<SVGGElement>('[id*="-node_"][transform]'),
  );
  const root = mindmapNodes.find((node) => node.id.endsWith("-node_0"));
  expect(root).toBeDefined();
  const rootY = parseTranslate(root!).y;
  const childY = mindmapNodes.filter((node) => node !== root).map((node) => parseTranslate(node).y);
  expect(childY.some((y) => y < rootY)).toBe(true);
  expect(childY.some((y) => y > rootY)).toBe(true);

  expect(lanes.querySelector("#Gateway")).not.toBeNull();
  expect(lanes.querySelector("#Runtime")).not.toBeNull();
  const admit = parseTranslate(lanes.querySelector('[id*="-flowchart-Admit-"]')!);
  const execute = parseTranslate(lanes.querySelector('[id*="-flowchart-Execute-"]')!);
  expect(admit.x).toBe(execute.x);
  expect(admit.y).not.toBe(execute.y);
});

it("enforces host source and edge limits despite source configuration, then recovers", async () => {
  await expect(renderMermaidSvg("x".repeat(20_001), theme)).rejects.toThrow(/characters/u);
  const source = `%%{init: {"maxEdges": 1000}}%%\nflowchart LR\n${Array.from({ length: 201 }, (_, index) => `A${index} --> A${index + 1}`).join("\n")}`;
  await expect(renderMermaidSvg(source, theme)).rejects.toThrow(/edge/iu);
  await expect(renderMermaidSvg("flowchart LR\nA -->", theme)).rejects.toThrow();
  const recovered = await renderSvg("flowchart LR\nA[Recovered] --> B[Ready]");
  expect(recovered.textContent).toContain("Recovered");
});

it("preserves Unicode at the sandbox error boundary", async () => {
  const prefix = "No diagram type detected matching given configuration for text: ";
  const source = `${"x".repeat(935)}😀`;

  await expect(renderMermaidSvg(source, theme)).rejects.toMatchObject({
    message: `${prefix}${"x".repeat(935)}`,
  });
});

it("blocks image decoding inside Mermaid before the SVG reaches the host", async () => {
  const image = btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
  );
  const source = `flowchart LR\nA@{ img: "data:image/svg+xml;base64,${image}", label: "Image" }`;
  await expect(renderMermaidSvg(source, theme)).rejects.toThrow();
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
