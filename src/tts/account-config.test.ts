import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { getResolvedSpeechProviderConfig, resolveTtsConfigForAccount } from "./tts.js";

function getMicrosoftConfig(cfg: ReturnType<typeof resolveTtsConfigForAccount>) {
  return getResolvedSpeechProviderConfig(cfg, "microsoft") as {
    voice?: string;
    lang?: string;
    outputFormat?: string;
  };
}

describe("resolveTtsConfigForAccount", () => {
  const baseCfg: OpenClawConfig = {
    messages: {
      tts: {
        provider: "edge",
        edge: {
          voice: "zh-CN-XiaoyiNeural",
          lang: "zh-CN",
        },
      },
    },
  };

  it("falls back to global config when the channel does not support account TTS", () => {
    const cfg: OpenClawConfig = {
      ...baseCfg,
      channels: {
        telegram: {
          accounts: {
            "my-bot": {
              tts: {
                edge: {
                  voice: "en-US-JennyNeural",
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const config = resolveTtsConfigForAccount(cfg, "telegram", "my-bot");
    expect(getMicrosoftConfig(config).voice).toBe("zh-CN-XiaoyiNeural");
    expect(getMicrosoftConfig(config).lang).toBe("zh-CN");
  });

  it("treats a missing account id as the default account", () => {
    const cfg: OpenClawConfig = {
      ...baseCfg,
      channels: {
        feishu: {
          accounts: {
            default: {
              tts: {
                provider: "edge",
                edge: {
                  voice: "en-US-JennyNeural",
                  lang: "en-US",
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const config = resolveTtsConfigForAccount(cfg, "feishu");
    expect(getMicrosoftConfig(config).voice).toBe("en-US-JennyNeural");
    expect(getMicrosoftConfig(config).lang).toBe("en-US");
  });

  it("uses the channel defaultAccount when account id is missing", () => {
    const cfg: OpenClawConfig = {
      ...baseCfg,
      channels: {
        feishu: {
          defaultAccount: "Ops Team",
          accounts: {
            "Ops Team": {
              tts: {
                provider: "edge",
                edge: {
                  voice: "en-US-JennyNeural",
                  lang: "en-US",
                },
              },
            },
            default: {
              tts: {
                provider: "edge",
                edge: {
                  voice: "fr-FR-DeniseNeural",
                  lang: "fr-FR",
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const config = resolveTtsConfigForAccount(cfg, "feishu");
    expect(getMicrosoftConfig(config).voice).toBe("en-US-JennyNeural");
    expect(getMicrosoftConfig(config).lang).toBe("en-US");
  });

  it("uses account TTS override when configured", () => {
    const cfg: OpenClawConfig = {
      ...baseCfg,
      channels: {
        feishu: {
          accounts: {
            "english-bot": {
              tts: {
                provider: "edge",
                edge: {
                  voice: "en-US-JennyNeural",
                  lang: "en-US",
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const config = resolveTtsConfigForAccount(cfg, "feishu", "english-bot");
    expect(getMicrosoftConfig(config).voice).toBe("en-US-JennyNeural");
    expect(getMicrosoftConfig(config).lang).toBe("en-US");
  });

  it("matches account TTS overrides with normalized account ids", () => {
    const cfg: OpenClawConfig = {
      ...baseCfg,
      channels: {
        feishu: {
          accounts: {
            "Ops Team": {
              tts: {
                provider: "edge",
                edge: {
                  voice: "en-US-JennyNeural",
                  lang: "en-US",
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const config = resolveTtsConfigForAccount(cfg, "feishu", "ops-team");
    expect(getMicrosoftConfig(config).voice).toBe("en-US-JennyNeural");
    expect(getMicrosoftConfig(config).lang).toBe("en-US");
  });

  it("merges partial account TTS with global config", () => {
    const cfg: OpenClawConfig = {
      ...baseCfg,
      channels: {
        feishu: {
          accounts: {
            "my-bot": {
              tts: {
                edge: {
                  voice: "en-US-JennyNeural",
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const config = resolveTtsConfigForAccount(cfg, "feishu", "my-bot");
    expect(getMicrosoftConfig(config).voice).toBe("en-US-JennyNeural");
    expect(getMicrosoftConfig(config).lang).toBe("zh-CN");
    expect(config.provider).toBe("microsoft");
  });

  it("preserves inherited microsoft alias fields for partial account overrides", () => {
    const cfg: OpenClawConfig = {
      messages: {
        tts: {
          provider: "microsoft",
          microsoft: {
            voice: "zh-CN-XiaoyiNeural",
            lang: "zh-CN",
            outputFormat: "audio-24khz-48kbitrate-mono-mp3",
          },
        },
      },
      channels: {
        feishu: {
          accounts: {
            "ops-team": {
              tts: {
                microsoft: {
                  voice: "en-US-JennyNeural",
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const config = resolveTtsConfigForAccount(cfg, "feishu", "ops-team");
    expect(config.provider).toBe("microsoft");
    expect(getMicrosoftConfig(config).voice).toBe("en-US-JennyNeural");
    expect(getMicrosoftConfig(config).lang).toBe("zh-CN");
    expect(getMicrosoftConfig(config).outputFormat).toBe("audio-24khz-48kbitrate-mono-mp3");
  });

  it("returns global config for non-existent channel or account", () => {
    const config = resolveTtsConfigForAccount(baseCfg, "nonexistent", "unknown");
    expect(getMicrosoftConfig(config).voice).toBe("zh-CN-XiaoyiNeural");
    expect(getMicrosoftConfig(config).lang).toBe("zh-CN");
  });
});
