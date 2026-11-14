import { existsSync, readFileSync, readdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { renderBlobsterSvgFromDesignText } from "../agents/blobster-generation.js";
import { defaultRuntime } from "../runtime.js";
import { agentsRenderBlobsterCommand } from "./agents.commands.blobster.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const EMPTY_LAYERS = {
  back: "",
  left_prop: "",
  right_prop: "",
  shell_overlay: "",
  accessory: "",
};
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const runtime = createTestRuntime();

describe("agents render-blobster command", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(defaultRuntime, "log").mockImplementation(runtime.log);
    vi.spyOn(defaultRuntime, "error").mockImplementation(runtime.error);
    vi.spyOn(defaultRuntime, "exit").mockImplementation(runtime.exit);
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation((value) =>
      runtime.log(JSON.stringify(value)),
    );
  });

  it("renders reference fixtures to byte-identical SVG and 256x256 RGBA PNG", async () => {
    const dir = tempDirs.make("blobster-render-");
    const fixturesUrl = new URL("../agents/blobster-fixtures/", import.meta.url);
    const fixtureFiles = readdirSync(fixturesUrl).filter((file) => file.endsWith(".json"));
    expect(fixtureFiles.length).toBeGreaterThan(0);

    for (const filename of fixtureFiles) {
      const rawFixture = JSON.parse(readFileSync(new URL(filename, fixturesUrl), "utf8")) as {
        bounds?: unknown;
        id: string;
        name: string;
        description: string;
        layers: Record<string, string>;
      };
      const { bounds: _bounds, ...rest } = rawFixture;
      const normalized = JSON.stringify({
        ...rest,
        layers: { ...EMPTY_LAYERS, ...rawFixture.layers },
      });
      const designPath = path.join(dir, filename);
      const svgOut = path.join(dir, "out", `${rawFixture.id}.svg`);
      await fs.writeFile(designPath, normalized, "utf8");

      await agentsRenderBlobsterCommand({ design: designPath, out: svgOut, json: true });
      const summary = JSON.parse(
        String(expectDefined(runtime.log.mock.calls.at(-1)?.[0], "json log")),
      );
      const writtenSvg = await fs.readFile(svgOut, "utf8");
      const expected = renderBlobsterSvgFromDesignText(normalized);
      expect(writtenSvg).toBe(expected.svg);
      expect(summary).toEqual({
        id: expected.id,
        name: expected.name,
        description: expected.description,
        out: svgOut,
        format: "svg",
        bytes: Buffer.byteLength(expected.svg, "utf8"),
      });
    }

    const guide = await fs.readFile(
      path.resolve("skills/create-blobster/references/design-guide.md"),
      "utf8",
    );
    const guideJson = expectDefined(
      /```json\r?\n([\s\S]*?)\r?\n```/u.exec(guide)?.[1],
      "guide json",
    );
    const pngOut = path.join(dir, "out", "radar-watch.png");
    const originalStdin = expectDefined(
      Object.getOwnPropertyDescriptor(process, "stdin"),
      "stdin descriptor",
    );
    Object.defineProperty(process, "stdin", {
      configurable: true,
      value: Readable.from([Buffer.from(guideJson, "utf8")]),
    });
    try {
      await agentsRenderBlobsterCommand({ design: "-", out: pngOut });
    } finally {
      Object.defineProperty(process, "stdin", originalStdin);
    }
    const png = await fs.readFile(pngOut);
    expect(png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    expect(png.toString("ascii", 12, 16)).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(256);
    expect(png.readUInt32BE(20)).toBe(256);
    expect(png[25]).toBe(6);
    expect(runtime.log.mock.calls.flat()).toContain("Name: Radar Watch");
  });

  it.each<[string, (dir: string) => Promise<{ design: string; out: string }>, RegExp]>([
    [
      "blank design",
      async (dir) => ({ design: "   ", out: path.join(dir, "x", "a.svg") }),
      /Design path must not be blank/,
    ],
    [
      "blank --out",
      async (dir) => ({ design: path.join(dir, "d.json"), out: " " }),
      /--out must not be blank/,
    ],
    [
      "unsupported extension",
      async (dir) => ({ design: path.join(dir, "d.json"), out: path.join(dir, "x", "a.jpg") }),
      /--out must end with \.svg or \.png/,
    ],
    [
      "missing file",
      async (dir) => ({
        design: path.join(dir, "missing.json"),
        out: path.join(dir, "x", "a.svg"),
      }),
      /Design file not found/,
    ],
    [
      "directory input",
      async (dir) => ({ design: dir, out: path.join(dir, "x", "a.svg") }),
      /Design file is a directory/,
    ],
    [
      "hostile SVG fragment",
      async (dir) => {
        const bad = path.join(dir, "bad.json");
        await fs.writeFile(
          bad,
          JSON.stringify({
            version: 1,
            id: "bad-script",
            name: "Bad",
            description: "Bad",
            palette: { shell: "#112233", claw: "#223344", glint: "#ffffff" },
            layers: { ...EMPTY_LAYERS, accessory: "<script>alert(1)</script>" },
          }),
        );
        return { design: bad, out: path.join(dir, "x", "a.svg") };
      },
      /Invalid Blobster design: Unsupported SVG element/,
    ],
  ])("rejects %s without creating output files", async (_case, setup, pattern) => {
    const dir = tempDirs.make("blobster-invalid-");
    const opts = await setup(dir);
    await expect(agentsRenderBlobsterCommand(opts)).rejects.toMatchObject({
      name: "ExpectedCliError",
      message: expect.stringMatching(pattern),
    });
    if (opts.out.trim()) {
      expect(existsSync(opts.out)).toBe(false);
      expect(existsSync(path.dirname(opts.out))).toBe(false);
    }
  });
});
