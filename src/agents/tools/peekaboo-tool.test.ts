import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPeekabooArgs, createPeekabooTool } from "./peekaboo-tool.js";

const ONE_PIXEL_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

describe("peekaboo tool", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function makeTempDir() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-peekaboo-test-"));
    tempDirs.push(dir);
    return dir;
  }

  it("builds targeted click args without shell interpolation", () => {
    const built = buildPeekabooArgs({
      action: "click",
      app: "Safari",
      on: "elem_7; rm -rf /",
    });

    expect(built.args).toEqual(["click", "--app", "Safari", "--on", "elem_7; rm -rf /"]);
  });

  it("opens URLs through peekaboo open with structured args", async () => {
    const execFile = vi.fn(
      (
        _file: string,
        _args: string[],
        _options: { timeout: number; maxBuffer: number },
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(
          null,
          JSON.stringify({ success: true, data: { target: "https://example.com" } }),
          "",
        );
      },
    );
    const tool = createPeekabooTool({
      deps: { execFile, platform: "darwin" },
    });

    const result = await tool.execute?.("call-1", {
      action: "open",
      url: "https://example.com",
      app: "Safari",
    });

    expect(execFile).toHaveBeenCalledWith(
      "peekaboo",
      ["open", "https://example.com", "--app", "Safari", "--wait-until-ready", "--json"],
      expect.objectContaining({ timeout: 20_000 }),
      expect.any(Function),
    );
    expect(result?.details).toMatchObject({ ok: true, action: "open" });
  });

  it("returns screenshots as image content when see writes a file", async () => {
    const tmpDir = await makeTempDir();
    const execFile = vi.fn(
      (
        _file: string,
        args: string[],
        _options: { timeout: number; maxBuffer: number },
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const outPath = args[args.indexOf("--path") + 1];
        void fs.writeFile(outPath, Buffer.from(ONE_PIXEL_PNG_B64, "base64")).then(() => {
          callback(
            null,
            JSON.stringify({
              success: true,
              data: { screenshot_raw: outPath, element_count: 3 },
            }),
            "",
          );
        });
      },
    );
    const tool = createPeekabooTool({
      deps: { execFile, tmpDir, platform: "darwin" },
      config: { agents: { defaults: { imageMaxDimensionPx: 1200 } } },
    });

    const result = await tool.execute?.("call-1", {
      action: "see",
      app: "Safari",
      annotate: true,
    });

    expect(execFile).toHaveBeenCalledWith(
      "peekaboo",
      expect.arrayContaining(["see", "--app", "Safari", "--annotate", "--path"]),
      expect.any(Object),
      expect.any(Function),
    );
    expect(result?.content.some((block) => block.type === "image")).toBe(true);
    expect(result?.details).toMatchObject({ ok: true, action: "see" });
  });

  it("fails clearly on non-macOS hosts", async () => {
    const tool = createPeekabooTool({
      deps: { execFile: vi.fn(), platform: "linux" },
    });

    await expect(tool.execute?.("call-1", { action: "status" })).rejects.toThrow(
      /only available on macOS/i,
    );
  });
});
