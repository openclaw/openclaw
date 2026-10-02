import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { boundMcpToolResultPayload } from "./invoke-mcp-result.js";

const execFileAsync = promisify(execFile);

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

  it("drops compact or reordered JSON mirrors of structured content", () => {
    const structuredContent = { answer: 42, items: [1, 2] };
    const payload = boundMcpToolResultPayload({
      content: [
        { type: "text", text: JSON.stringify(structuredContent) },
        { type: "text", text: '{"items":[1,2],"answer":42}' },
        { type: "text", text: '{"answer":41}' },
        { type: "text", text: "authentication expired; run login" },
      ],
      structuredContent,
    });
    expect(payload).toEqual({
      content: [
        { type: "text", text: '{"answer":41}' },
        { type: "text", text: "authentication expired; run login" },
      ],
      structuredContent,
    });
  });
});
