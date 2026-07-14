import { describe, expect, it } from "vitest";
import type { BundledPluginSource } from "./bundled-sources.js";
import { isOpenClawTrustedPluginInstallSpec } from "./install-provenance.js";

const bundledSources = new Map<string, BundledPluginSource>([
  [
    "discord",
    {
      pluginId: "discord",
      localPath: "/opt/openclaw/extensions/discord",
      npmSpec: "@openclaw/discord",
    },
  ],
  [
    "sherpa-onnx-tts",
    {
      pluginId: "sherpa-onnx-tts",
      localPath: "/repo/extensions/sherpa-onnx-tts",
      npmSpec: "@openclaw/sherpa-onnx-tts",
    },
  ],
]);

describe("plugin install provenance", () => {
  it.each([
    "discord",
    "@openclaw/discord",
    "npm:@openclaw/discord",
    "/opt/openclaw/extensions/discord",
    "brave",
    "npm:@openclaw/brave-plugin",
    "clawhub:openclaw-demo",
  ])("trusts OpenClaw-owned install source %s", (spec) => {
    expect(isOpenClawTrustedPluginInstallSpec(spec, bundledSources)).toBe(true);
  });

  it.each(["npm:discord", "npm:@example/plugin", "/tmp/example-plugin"])(
    "keeps arbitrary install source %s untrusted",
    (spec) => {
      expect(isOpenClawTrustedPluginInstallSpec(spec, bundledSources)).toBe(false);
    },
  );

  it("keeps ClawHub-only catalog packages untrusted for npm installs", () => {
    expect(
      isOpenClawTrustedPluginInstallSpec("npm:@openclaw/sherpa-onnx-tts", bundledSources),
    ).toBe(false);
  });
});
