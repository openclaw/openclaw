import { describe, expect, it } from "vitest";
import { validateConfigObjectWithPlugins } from "./validation.js";

const mediaCliWarnings = (models: unknown[]) => {
  const result = validateConfigObjectWithPlugins(
    { tools: { media: { audio: { enabled: true }, models } } },
    { pluginMetadataSnapshot: { manifestRegistry: { diagnostics: [], plugins: [] } } },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("expected valid config");
  }
  return result.warnings.filter((warning) => warning.path.startsWith("tools.media.models."));
};

describe("media CLI entry config warnings", () => {
  it("warns when a cli entry has no command", () => {
    expect(mediaCliWarnings([{ type: "cli", capabilities: ["audio"] }])).toEqual([
      {
        path: "tools.media.models.0.command",
        message:
          "Media model entry resolves to a CLI entry but has no usable command; it fails on the first attachment. Set command, or drop type to use a provider entry.",
      },
    ]);
  });

  it("warns when a cli entry runs its command with no args", () => {
    expect(
      mediaCliWarnings([
        { type: "cli", command: "/usr/local/bin/oc-transcribe", capabilities: ["audio"] },
      ]),
    ).toEqual([
      {
        path: "tools.media.models.0.args",
        message:
          'Media CLI entry "/usr/local/bin/oc-transcribe" has no args, so the attachment path is never passed to it. Add an attachment placeholder such as {{AttachmentPath}}.',
      },
    ]);
  });

  it("warns for an inferred cli entry whose command is only whitespace", () => {
    // runner.ts infers "cli" from the raw command, so this entry reaches CLI
    // execution and throws there. Trimming before inferring would hide it.
    expect(mediaCliWarnings([{ command: "   ", capabilities: ["audio"] }])).toEqual([
      {
        path: "tools.media.models.0.command",
        message:
          "Media model entry resolves to a CLI entry but has no usable command; it fails on the first attachment. Set command, or drop type to use a provider entry.",
      },
    ]);
  });

  it("reports the failing index for the entry that is incomplete", () => {
    expect(
      mediaCliWarnings([
        { type: "cli", command: "whisper-cli", args: ["{{AttachmentPath}}"] },
        { type: "cli", command: "oc-transcribe", args: [] },
      ]).map((warning) => warning.path),
    ).toEqual(["tools.media.models.1.args"]);
  });

  it.each([
    {
      name: "complete cli entry",
      entry: { type: "cli", command: "w", args: ["{{AttachmentPath}}"] },
    },
    { name: "inferred cli entry with args", entry: { command: "w", args: ["{{AttachmentPath}}"] } },
    { name: "provider entry", entry: { provider: "openai", model: "gpt-6-astra" } },
  ])("stays quiet for a $name", ({ entry }) => {
    expect(mediaCliWarnings([entry])).toEqual([]);
  });
});
