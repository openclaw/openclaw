import { describe, expect, it, vi } from "vitest";
import { buildSlackManifest, writeSlackManifestRaw } from "./slack.js";

describe("buildSlackManifest", () => {
  it("builds valid manifest JSON without framing characters", () => {
    const manifest = buildSlackManifest("OpenClaw");
    const parsed = JSON.parse(manifest) as { display_information?: { name?: string } };
    expect(parsed.display_information?.name).toBe("OpenClaw");
    expect(manifest).not.toContain("│");
  });
});

describe("writeSlackManifestRaw", () => {
  it("writes raw manifest content with trailing newline", () => {
    const write = vi.fn<Pick<NodeJS.WriteStream, "write">["write"]>(() => true);
    const manifest = '{\n  "hello": "world"\n}';

    writeSlackManifestRaw(manifest, { write });

    expect(write).toHaveBeenCalledWith(`${manifest}\n`);
  });
});
