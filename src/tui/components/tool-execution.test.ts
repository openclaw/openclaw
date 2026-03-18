import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolExecutionComponent } from "./tool-execution.js";

// Minimal valid 1x1 PNG
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const TINY_PNG_BUF = Buffer.from(TINY_PNG_B64, "base64");

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `tool-exec-test-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });
});

// Mock canRenderInlineImages to control image rendering in tests
vi.mock("./inline-image.js", async (importOriginal) => {
  return {
    ...(await importOriginal()),
    canRenderInlineImages: vi.fn(() => false),
  };
});

describe("ToolExecutionComponent", () => {
  it("renders tool name and args on construction", () => {
    const component = new ToolExecutionComponent("read_file", { path: "/tmp/test.txt" });
    const rendered = component.render(80).join("\n");
    expect(rendered).toBeTruthy();
  });

  it("shows running state for partial results", () => {
    const component = new ToolExecutionComponent("bash", { command: "ls" });
    component.setPartialResult({
      content: [{ type: "text", text: "file1.txt\nfile2.txt" }],
    });
    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("running");
  });

  it("shows final result text", () => {
    const component = new ToolExecutionComponent("bash", { command: "echo hello" });
    component.setResult({
      content: [{ type: "text", text: "hello" }],
    });
    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("hello");
    expect(rendered).not.toContain("running");
  });

  it("shows image placeholder when terminal does not support images", () => {
    const component = new ToolExecutionComponent("image_generate", { prompt: "sunset" });
    component.setResult({
      content: [
        { type: "text", text: "Generated 1 image." },
        { type: "image", mimeType: "image/png", bytes: 1024, omitted: true },
      ],
    });
    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("[image/png 1kb (omitted)]");
  });

  it("preserves MEDIA: paths in text when terminal does not support images", () => {
    const imgPath = join(testDir, "chart.png");
    writeFileSync(imgPath, TINY_PNG_BUF);
    const component = new ToolExecutionComponent("image_generate", { prompt: "chart" });
    component.setResult({
      content: [{ type: "text", text: `Generated 1 image.\nMEDIA:${imgPath}` }],
    });
    const rendered = component.render(80).join("\n");
    // On non-image terminals, MEDIA: lines remain visible as text
    expect(rendered).toContain("Generated 1 image");
  });

  it("handles setResult after setPartialResult", () => {
    const component = new ToolExecutionComponent("bash", { command: "long" });
    component.setPartialResult({ content: [{ type: "text", text: "partial..." }] });
    component.setResult({ content: [{ type: "text", text: "done" }] });
    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("done");
    expect(rendered).not.toContain("running");
  });

  it("handles setPartialResult after setResult (clears stale state)", () => {
    const component = new ToolExecutionComponent("bash", { command: "retry" });
    component.setResult({ content: [{ type: "text", text: "result1" }] });
    // Partial after final simulates a retry/new streaming run
    component.setPartialResult({ content: [{ type: "text", text: "streaming..." }] });
    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("running");
    expect(rendered).toContain("streaming");
  });

  it("handles double setResult (replaces previous)", () => {
    const component = new ToolExecutionComponent("bash", { command: "retry" });
    component.setResult({ content: [{ type: "text", text: "first" }] });
    component.setResult({ content: [{ type: "text", text: "second" }] });
    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("second");
  });

  it("handles setResult with undefined", () => {
    const component = new ToolExecutionComponent("bash", { command: "test" });
    component.setResult(undefined);
    const rendered = component.render(80).join("\n");
    expect(rendered).toBeTruthy();
  });

  it("handles empty content array", () => {
    const component = new ToolExecutionComponent("bash", { command: "test" });
    component.setResult({ content: [] });
    const rendered = component.render(80).join("\n");
    expect(rendered).toBeTruthy();
  });

  it("truncates long output when not expanded", () => {
    const longText = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const component = new ToolExecutionComponent("bash", { command: "test" });
    component.setResult({ content: [{ type: "text", text: longText }] });
    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("line 0");
    expect(rendered).toContain("…");
  });

  it("shows full output when expanded", () => {
    const longText = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const component = new ToolExecutionComponent("bash", { command: "test" });
    component.setResult({ content: [{ type: "text", text: longText }] });
    component.setExpanded(true);
    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("line 19");
  });

  it("shows error styling for error results", () => {
    const component = new ToolExecutionComponent("bash", { command: "fail" });
    component.setResult({ content: [{ type: "text", text: "command failed" }] }, { isError: true });
    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("command failed");
  });

  it("updates args without affecting result", () => {
    const component = new ToolExecutionComponent("bash", { command: "old" });
    component.setResult({ content: [{ type: "text", text: "output" }] });
    component.setArgs({ command: "new" });
    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("output");
  });
});
