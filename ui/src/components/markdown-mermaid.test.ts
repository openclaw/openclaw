/* @vitest-environment jsdom */

import { MermaidTransientError, renderMermaidSvg } from "@openclaw/mermaid-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { copyToClipboard } from "../lib/clipboard.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { mountMermaidBlocks } from "./markdown-mermaid.tsx";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

vi.mock("@openclaw/mermaid-renderer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/mermaid-renderer")>()),
  renderMermaidSvg: vi.fn(),
}));
vi.mock("../lib/clipboard.ts", () => ({ copyToClipboard: vi.fn() }));

type MermaidElement = HTMLElementTagNameMap["openclaw-mermaid"];
const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Rendered diagram</text></svg>';
const renderSvg = vi.mocked(renderMermaidSvg);
const copySource = vi.mocked(copyToClipboard);
const containers = new Set<HTMLElement>();
let sourceSequence = 0;
let rootAttributes: [string, string | null][];
let createObjectURL: ReturnType<typeof vi.fn<(blob: Blob | MediaSource) => string>>;
let revokeObjectURL: ReturnType<typeof vi.fn<(url: string) => void>>;

function source(label: string): string {
  return `flowchart LR\n  A["${label} ${++sourceSequence}"] --> B\n`;
}

async function mount(label: string, copies = 1) {
  const original = source(label);
  const container = document.body.appendChild(document.createElement("div"));
  containers.add(container);
  const markdown = Array<string>(copies).fill(`\`\`\`mermaid\n${original}\`\`\``).join("\n\n");
  container.innerHTML = toSanitizedMarkdownHtml(markdown);
  mountMermaidBlocks(container);
  const elements = [...container.querySelectorAll("openclaw-mermaid")];
  expect(elements).toHaveLength(copies);
  await Promise.all(elements.map((element) => element.updateComplete));
  return { original, container, elements, element: elements[0]! };
}

function action(element: MermaidElement, label: string) {
  const match = [...element.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) =>
      (candidate.getAttribute("aria-label") ?? candidate.textContent?.trim()) === label,
  );
  expect(match, `Missing Mermaid action: ${label}`).toBeDefined();
  return match!;
}

async function selectAction(element: MermaidElement, label: string) {
  const trigger = action(element, "Diagram options");
  trigger.click();
  await waitForSolid(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
  action(element, label).click();
  await waitForSolid(() => expect(trigger.getAttribute("aria-expanded")).toBe("false"));
}

function imageSource(element: MermaidElement): string | null | undefined {
  return element.querySelector("img")?.getAttribute("src");
}

async function waitForImage(element: MermaidElement): Promise<string> {
  await waitForSolid(() => expect(imageSource(element)).toMatch(/^blob:mermaid-/u));
  return imageSource(element)!;
}

async function pendingDiagram(label: string, copies = 1) {
  const pending = createDeferred<string>();
  renderSvg.mockReturnValueOnce(pending.promise);
  return { pending, ...(await mount(label, copies)) };
}

async function expectCopyableSource(element: MermaidElement, original: string, disabled: boolean) {
  expect(element.querySelector("code")?.textContent).toBe(original);
  expect(element.querySelector("img, script")).toBeNull();
  expect(action(element, "Expand diagram").disabled).toBe(disabled);
  action(element, "Copy source").click();
  await waitForSolid(() => expect(copySource.mock.calls.map(([text]) => text)).toEqual([original]));
}

async function disconnect(element: MermaidElement) {
  element.remove();
  await Promise.resolve();
}

beforeEach(() => {
  renderSvg.mockReset().mockResolvedValue(svg);
  copySource.mockReset().mockResolvedValue(true);
  let urlSequence = 0;
  createObjectURL = vi.fn(() => `blob:mermaid-${++urlSequence}`);
  revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL }));
  const root = document.documentElement;
  rootAttributes = ["data-theme-mode", "style"].map((name) => [name, root.getAttribute(name)]);
  root.dataset.themeMode = "light";
  for (const property of ["--card", "--text", "--muted", "--border", "--accent"]) {
    root.style.setProperty(property, "#123456");
  }
});

afterEach(async () => {
  for (const container of containers) {
    container.remove();
  }
  containers.clear();
  await Promise.resolve();
  for (const [attribute, value] of rootAttributes) {
    if (value === null) {
      document.documentElement.removeAttribute(attribute);
    } else {
      document.documentElement.setAttribute(attribute, value);
    }
  }
  vi.unstubAllGlobals();
});

it("mounts a newly inserted diagram without replacing an existing sibling", async () => {
  const { container, elements } = await mount("Existing diagram");
  const nextSource = source("Inserted diagram");
  container.insertAdjacentHTML(
    "beforeend",
    toSanitizedMarkdownHtml(`\`\`\`mermaid\n${nextSource}\`\`\``),
  );
  const block = container.lastElementChild!;

  expect(mountMermaidBlocks(block)).toBe(true);
  expect(container.querySelectorAll("openclaw-mermaid")[0]).toBe(elements[0]);
  const diagram = block.querySelector("openclaw-mermaid")!;
  expect(diagram.source).toBe(nextSource);
  await diagram.updateComplete;
});

it("preserves source and reports copy failure", async () => {
  copySource.mockResolvedValueOnce(false);
  const { original, container, element } = await mount("x < y & z <script>alert(1)</script>");
  const imageUrl = await waitForImage(element!);

  expect(renderSvg).toHaveBeenCalledWith(original, expect.objectContaining({ darkMode: false }));
  expect(action(element!, "Expand diagram").disabled).toBe(false);
  await selectAction(element!, "Show source");
  await expectCopyableSource(element, original, false);
  expect(mountMermaidBlocks(container)).toBe(false);
  expect(container.querySelector("openclaw-mermaid")).toBe(element);
  await waitForSolid(() => expect(action(element, "Copy failed")).toBeDefined());

  await selectAction(element!, "Show diagram");
  expect(imageSource(element!)).toBe(imageUrl);
  expect(renderSvg).toHaveBeenCalledTimes(1);
});

it.each([
  { failure: "layout", message: "Check the source or simplify the diagram" },
  { failure: "renderer", message: "check proxy or authentication rules" },
  { failure: "image", message: "The diagram image could not be displayed" },
])("keeps $failure failures actionable, readable and copyable", async ({ failure, message }) => {
  if (failure === "layout") {
    renderSvg.mockRejectedValueOnce(new Error("<script>internal parser detail</script>"));
  } else if (failure === "renderer") {
    renderSvg.mockRejectedValueOnce(new MermaidTransientError("Renderer could not load"));
  }
  const { original, element } = await mount("Invalid diagram");
  if (failure === "image") {
    await waitForImage(element!);
    element!.querySelector("img")?.dispatchEvent(new Event("error"));
  }

  await waitForSolid(() =>
    expect(element!.querySelector('[role="status"]')?.textContent).toContain(message),
  );
  await expectCopyableSource(element, original, true);
  expect(element!.textContent).not.toContain("internal parser detail");
  if (failure === "image") {
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:mermaid-1");
  } else {
    expect(createObjectURL).not.toHaveBeenCalled();
  }
});

it.each(["source", "theme"])("ignores a stale layout after a %s change", async (change) => {
  const old = createDeferred<string>();
  const current = createDeferred<string>();
  renderSvg.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  const { element } = await mount("Old diagram");
  expect(renderSvg).toHaveBeenCalledTimes(1);
  if (change === "source") {
    element!.source = source("Current diagram");
  } else {
    document.documentElement.dataset.themeMode = "dark";
  }
  await waitForSolid(() => expect(renderSvg).toHaveBeenCalledTimes(2));
  if (change === "theme") {
    expect(renderSvg.mock.calls[1]?.[1].darkMode).toBe(true);
  }
  current.resolve(svg);
  const imageUrl = await waitForImage(element!);
  if (change === "source") {
    old.resolve(svg);
  } else {
    old.reject(new Error("Stale failure"));
  }
  await old.promise.catch(() => {});
  await element!.updateComplete;

  expect(imageSource(element!)).toBe(imageUrl);
  expect(element!.querySelector('[role="status"]')).toBeNull();
  expect(createObjectURL).toHaveBeenCalledTimes(1);
  expect(revokeObjectURL).not.toHaveBeenCalled();
});

it.each([true, false])(
  "releases URLs across reconnect with disconnect before render=%s",
  async (disconnectBeforeRender) => {
    const { pending, container, element } = await pendingDiagram("Reconnected diagram");
    if (!disconnectBeforeRender) {
      pending.resolve(svg);
      await waitForImage(element!);
    }
    await disconnect(element);
    if (disconnectBeforeRender) {
      pending.resolve(svg);
      await pending.promise;
      expect(createObjectURL).not.toHaveBeenCalled();
    } else {
      expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:mermaid-1");
    }

    container.append(element!);
    const reconnectedUrl = disconnectBeforeRender ? "blob:mermaid-1" : "blob:mermaid-2";
    await waitForSolid(() => expect(imageSource(element!)).toBe(reconnectedUrl));
    expect(renderSvg).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledTimes(disconnectBeforeRender ? 1 : 2);
    await disconnect(element);
    expect(revokeObjectURL).toHaveBeenCalledWith(reconnectedUrl);
    expect(revokeObjectURL).toHaveBeenCalledTimes(createObjectURL.mock.calls.length);
  },
);

it("shares concurrent layout work while each displayed diagram owns its URL", async () => {
  const { pending, elements } = await pendingDiagram("Shared layout", 2);
  expect(renderSvg).toHaveBeenCalledTimes(1);
  pending.resolve(svg);
  const [firstUrl, secondUrl] = await Promise.all(elements.map(waitForImage));
  expect(firstUrl).not.toBe(secondUrl);

  await disconnect(elements[0]!);
  expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(firstUrl);
  expect(imageSource(elements[1]!)).toBe(secondUrl);
  expect(revokeObjectURL).not.toHaveBeenCalledWith(secondUrl);
});
