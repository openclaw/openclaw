import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { boundMcpToolResultPayload } from "./invoke-mcp-result.js";

const execFileAsync = promisify(execFile);

function buildDeepChain(levels: number): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let node = root;
  for (let i = 0; i < levels; i++) {
    const next: Record<string, unknown> = {};
    node.next = next;
    node = next;
  }
  node.leaf = "end";
  return root;
}

describe("boundMcpToolResultPayload", () => {
  it("bounds a resident 64 MiB audio result without full serialization", async () => {
    const source = String.raw`
      import { boundMcpToolResultPayload } from ${JSON.stringify(new URL("./invoke-mcp-result.ts", import.meta.url).href)};
      const payload = boundMcpToolResultPayload({
        content: [{ type: "audio", data: "A".repeat(64 * 1024 * 1024), mimeType: "audio/wav" }],
      });
      process.stdout.write(JSON.stringify(payload));
    `;
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--max-old-space-size=192", "--import", "tsx", "--input-type=module", "-e", source],
      { cwd: process.cwd(), encoding: "utf8", maxBuffer: 1024 * 1024 },
    );

    const payload = JSON.parse(stdout) as {
      content: Array<{ type: string; text?: string }>;
    };
    expect(payload.content).toEqual([
      { type: "text", text: "[truncated: MCP result exceeded 20 MB]" },
    ]);
  });

  it("keeps serializable structuredContent and filters its mirrored text block", () => {
    const structuredContent = { status: "ok", nested: { values: [1, 2, 3] } };
    const payload = boundMcpToolResultPayload({
      content: [
        { type: "text", text: JSON.stringify(structuredContent, null, 2) },
        { type: "text", text: "note" },
      ],
      structuredContent,
    });
    expect(payload.structuredContent).toEqual(structuredContent);
    expect(payload.content).toEqual([{ type: "text", text: "note" }]);
  });

  it("truncates structuredContent that passes measurement but overflows native serialization", () => {
    const structuredContent = buildDeepChain(100_000);
    expect(() => JSON.stringify(structuredContent)).toThrow(RangeError);
    const payload = boundMcpToolResultPayload({
      content: [{ type: "text", text: "ok" }],
      structuredContent,
    });
    expect(payload.structuredContent).toBeUndefined();
    expect(payload.content).toEqual([
      { type: "text", text: "ok" },
      { type: "text", text: "[truncated: MCP result exceeded 20 MB]" },
    ]);
  });

  it("drops a content block that passes measurement but overflows native serialization", () => {
    const deep = buildDeepChain(100_000);
    expect(() => JSON.stringify(deep)).toThrow(RangeError);
    const payload = boundMcpToolResultPayload({
      content: [
        { type: "text", text: "before" },
        { type: "resource", resource: deep },
        { type: "text", text: "after" },
      ],
    });
    expect(payload.content).toEqual([
      { type: "text", text: "before" },
      { type: "text", text: "after" },
      { type: "text", text: "[truncated: MCP result exceeded 20 MB]" },
    ]);
  });
});
