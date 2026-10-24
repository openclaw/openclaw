// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import type { BoardReport } from "../../../../../src/boards/board-report.ts";
import { boardWidget } from "../../../components/board/board-view.test-support.ts";
import "./report.tsx";

const widget = (props: Record<string, unknown>) =>
  boardWidget({
    title: "Weekly report",
    contentKind: "plugin",
    pluginKind: "session:report",
    props,
  });

async function mount(props: Record<string, unknown>) {
  const element = document.createElement("openclaw-report-widget");
  element.widget = widget(props);
  document.body.append(element);
  await element.updateComplete;
  return element;
}

afterEach(() => document.body.replaceChildren());

function chart(style: "bar" | "line", values: readonly number[]) {
  return {
    type: "chart" as const,
    style,
    points: values.map((value, index) => ({ label: `Point ${index + 1}`, value })),
  };
}

it("renders escaped report data with accessible metrics, tables, charts, and links", async () => {
  const markup = '<img src="https://example.com/tracker"> stays text.';
  const link = { label: "Details", url: "https://example.com/report", detail: "Read the source" };
  const element = await mount({
    blocks: [
      { type: "text", title: "Summary", text: markup },
      { type: "metrics", items: [{ label: "Resolved", value: "24", detail: "Up by six" }] },
      {
        type: "table",
        title: "Teams",
        columns: ["Team", "Count"],
        rows: [
          ["Core", "17"],
          ["UI", "7"],
        ],
      },
      { ...chart("line", [-3, 6]), title: "Trend" },
      { type: "links", title: "References", items: [link] },
    ],
  } satisfies BoardReport);
  const texts = (selector: string) =>
    [...element.querySelectorAll(selector)].map((node) => node.textContent);
  expect(element.querySelector("article")?.getAttribute("aria-label")).toBe("Weekly report");
  expect(element.textContent).toContain(markup);
  expect(element.querySelector("script,img,iframe,style")).toBeNull();
  expect(texts(".board-report__metrics dt")).toEqual(["Resolved"]);
  expect(texts(".board-report__metrics dd")).toEqual(["24", "Up by six"]);
  expect(element.querySelector("caption")?.textContent?.trim()).toBe("Teams");
  expect(texts("th[scope=col]")).toEqual(["Team", "Count"]);
  expect(texts("tbody td")).toEqual(["Core", "17", "UI", "7"]);
  expect(element.querySelector("polyline")?.namespaceURI).toBe("http://www.w3.org/2000/svg");
  expect(texts(".board-report__values dd")).toEqual(["-3", "6"]);
  expect(element.querySelector("a")).toMatchObject({
    href: "https://example.com/report",
    target: "_blank",
    rel: "noopener noreferrer",
  });
});

it.each([
  { style: "bar", values: [0] },
  { style: "bar", values: [-5, 0, 10] },
  { style: "line", values: [0] },
  { style: "line", values: [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER] },
] as const)("keeps $style geometry finite for $values", async ({ style, values }) => {
  const element = await mount({ blocks: [chart(style, values)] });
  const svg = element.querySelector("svg");
  expect(svg).not.toBeNull();
  expect(svg?.outerHTML).not.toMatch(/NaN|Infinity/);
  expect(element.querySelectorAll(style === "bar" ? "rect" : "circle")).toHaveLength(values.length);
});

it("updates saved data and contains invalid report content without executing it", async () => {
  const element = await mount({ blocks: [{ type: "text", text: "Original" }] });
  element.widget = widget({ blocks: [{ type: "text", text: "Updated" }] });
  await element.updateComplete;
  expect(element.textContent).toContain("Updated");
  expect(element.textContent).not.toContain("Original");
  element.widget = widget({
    blocks: [{ type: "links", items: [{ label: "Unsafe", url: "javascript:alert(1)" }] }],
  });
  await element.updateComplete;
  expect(element.querySelector('[role="alert"]')).not.toBeNull();
  expect(element.querySelector("a,iframe,script")).toBeNull();
});
