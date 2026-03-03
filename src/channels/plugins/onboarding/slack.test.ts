import { describe, expect, it, vi } from "vitest";
import { buildSlackManifest, writeSlackManifestRaw } from "./slack.js";

describe("buildSlackManifest", () => {
  it("builds valid manifest JSON without framing characters", () => {
    const manifest = buildSlackManifest("OpenClaw");
    const parsed = JSON.parse(manifest) as { display_information?: { name?: string } };
    expect(parsed.display_information?.name).toBe("OpenClaw");
    expect(manifest).not.toContain("│");
  });

  it("falls back to OpenClaw when botName is blank", () => {
    const manifest = buildSlackManifest("   ");
    const parsed = JSON.parse(manifest) as { display_information?: { name?: string } };
    expect(parsed.display_information?.name).toBe("OpenClaw");
  });
});

describe("writeSlackManifestRaw", () => {
  it("writes raw manifest content with trailing newline", () => {
    const stream = {
      write: (
        _buffer: string | Uint8Array,
        _encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
        _callback?: (err?: Error | null) => void,
      ) => true,
    } satisfies Pick<NodeJS.WriteStream, "write">;
    const writeSpy = vi.spyOn(stream, "write");
    const manifest = '{\n  "hello": "world"\n}';

    writeSlackManifestRaw(manifest, stream);

    expect(writeSpy).toHaveBeenCalledWith(`${manifest}\n`);
  });
});
