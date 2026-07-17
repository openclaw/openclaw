// TTS integration tests cover text-to-speech command behavior.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("tts runtime facade", () => {
  it("routes public TTS helpers through the core speech package", () => {
    const publicFacadeSource = readSource("./tts.ts");
    const runtimeFacadeSource = readSource("../plugin-sdk/tts-runtime.ts");

    expect(publicFacadeSource).toContain('} from "../plugin-sdk/tts-runtime.js";');
    expect(publicFacadeSource).not.toContain("speech-core");
    expect(runtimeFacadeSource).toContain('from "../../packages/speech-core/runtime-api.js";');
    expect(runtimeFacadeSource).not.toContain('dirName: "speech-core"');
  });

  it("keeps agent prompt TTS settings off the synthesis runtime chain", () => {
    const agentConfigSource = readSource("../agents/system-prompt-config.ts");
    const settingsFacadeSource = readSource("./tts-settings.ts");
    const packageSettingsSource = readSource("../../packages/speech-core/src/tts-settings.ts");

    expect(agentConfigSource).toContain('from "../tts/tts-settings.js";');
    expect(settingsFacadeSource).toContain(
      'from "../../packages/speech-core/src/tts-settings.js";',
    );
    expect(settingsFacadeSource).not.toContain("tts-runtime");
    expect(packageSettingsSource).toContain('from "openclaw/plugin-sdk/speech-settings";');
    expect(packageSettingsSource).not.toContain("plugin-sdk/media-runtime");
  });
});
