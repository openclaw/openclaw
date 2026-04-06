import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAcpVitestConfig } from "../vitest.acp.config.ts";
import { createAgentsVitestConfig } from "../vitest.agents.config.ts";
import { createAutoReplyVitestConfig } from "../vitest.auto-reply.config.ts";
import { createChannelsVitestConfig } from "../vitest.channels.config.ts";
import { createCliVitestConfig } from "../vitest.cli.config.ts";
import { createCommandsVitestConfig } from "../vitest.commands.config.ts";
import { createCronVitestConfig } from "../vitest.cron.config.ts";
import { createDaemonVitestConfig } from "../vitest.daemon.config.ts";
import { createExtensionAcpxVitestConfig } from "../vitest.extension-acpx.config.ts";
import { createExtensionBlueBubblesVitestConfig } from "../vitest.extension-bluebubbles.config.ts";
import { createExtensionChannelsVitestConfig } from "../vitest.extension-channels.config.ts";
import { createExtensionDiffsVitestConfig } from "../vitest.extension-diffs.config.ts";
import { createExtensionFeishuVitestConfig } from "../vitest.extension-feishu.config.ts";
import { createExtensionIrcVitestConfig } from "../vitest.extension-irc.config.ts";
import { createExtensionMatrixVitestConfig } from "../vitest.extension-matrix.config.ts";
import { createExtensionMattermostVitestConfig } from "../vitest.extension-mattermost.config.ts";
import { createExtensionMemoryVitestConfig } from "../vitest.extension-memory.config.ts";
import { createExtensionMessagingVitestConfig } from "../vitest.extension-messaging.config.ts";
import { createExtensionMsTeamsVitestConfig } from "../vitest.extension-msteams.config.ts";
import { createExtensionProvidersVitestConfig } from "../vitest.extension-providers.config.ts";
import { createExtensionTelegramVitestConfig } from "../vitest.extension-telegram.config.ts";
import { createExtensionVoiceCallVitestConfig } from "../vitest.extension-voice-call.config.ts";
import { createExtensionWhatsAppVitestConfig } from "../vitest.extension-whatsapp.config.ts";
import { createExtensionZaloVitestConfig } from "../vitest.extension-zalo.config.ts";
import { createExtensionsVitestConfig } from "../vitest.extensions.config.ts";
import { createGatewayVitestConfig } from "../vitest.gateway.config.ts";
import { createHooksVitestConfig } from "../vitest.hooks.config.ts";
import { createInfraVitestConfig } from "../vitest.infra.config.ts";
import { createLoggingVitestConfig } from "../vitest.logging.config.ts";
import { createMediaUnderstandingVitestConfig } from "../vitest.media-understanding.config.ts";
import { createMediaVitestConfig } from "../vitest.media.config.ts";
import { createPluginSdkVitestConfig } from "../vitest.plugin-sdk.config.ts";
import { createPluginsVitestConfig } from "../vitest.plugins.config.ts";
import { createProcessVitestConfig } from "../vitest.process.config.ts";
import { createRuntimeConfigVitestConfig } from "../vitest.runtime-config.config.ts";
import { createScopedVitestConfig, resolveVitestIsolation } from "../vitest.scoped-config.ts";
import { createSecretsVitestConfig } from "../vitest.secrets.config.ts";
import { createSharedCoreVitestConfig } from "../vitest.shared-core.config.ts";
import { createTasksVitestConfig } from "../vitest.tasks.config.ts";
import { createToolingVitestConfig } from "../vitest.tooling.config.ts";
import { createTuiVitestConfig } from "../vitest.tui.config.ts";
import { createUiVitestConfig } from "../vitest.ui.config.ts";
import { createUtilsVitestConfig } from "../vitest.utils.config.ts";
import { createWizardVitestConfig } from "../vitest.wizard.config.ts";
import { BUNDLED_PLUGIN_TEST_GLOB, bundledPluginFile } from "./helpers/bundled-plugin-paths.js";
import { cleanupTempDirs, makeTempDir } from "./helpers/temp-dir.js";

const EXTENSIONS_CHANNEL_GLOB = ["extensions", "channel", "**"].join("/");

describe("resolveVitestIsolation", () => {
  it("defaults shared scoped configs to the non-isolated runner", () => {
    expect(resolveVitestIsolation({})).toBe(false);
  });

  it("ignores the legacy isolation escape hatches", () => {
    expect(resolveVitestIsolation({ OPENCLAW_TEST_ISOLATE: "1" })).toBe(false);
    expect(resolveVitestIsolation({ OPENCLAW_TEST_NO_ISOLATE: "0" })).toBe(false);
    expect(resolveVitestIsolation({ OPENCLAW_TEST_NO_ISOLATE: "false" })).toBe(false);
  });
});

describe("createScopedVitestConfig", () => {
  it("applies the non-isolated runner by default", () => {
    const config = createScopedVitestConfig(["src/example.test.ts"], { env: {} });
    expect(config.test?.isolate).toBe(false);
    expect(config.test?.runner).toBe("./test/non-isolated-runner.ts");
    expect(config.test?.setupFiles).toEqual(["test/setup.ts", "test/setup-openclaw-runtime.ts"]);
  });

  it("passes through a scoped root dir when provided", () => {
    const config = createScopedVitestConfig(["src/example.test.ts"], {
      dir: "src",
      env: {},
    });
    expect(config.test?.dir).toBe("src");
    expect(config.test?.include).toEqual(["example.test.ts"]);
  });

  it("relativizes scoped include and exclude patterns to the configured dir", () => {
    const config = createScopedVitestConfig([BUNDLED_PLUGIN_TEST_GLOB], {
      dir: "extensions",
      env: {},
      exclude: [EXTENSIONS_CHANNEL_GLOB, "dist/**"],
    });

    expect(config.test?.include).toEqual(["**/*.test.ts"]);
    expect(config.test?.exclude).toEqual(expect.arrayContaining(["channel/**", "dist/**"]));
  });

  it("narrows scoped includes to matching CLI file filters", () => {
    const config = createScopedVitestConfig(["extensions/**/*.test.ts"], {
      argv: ["node", "vitest", "run", "extensions/browser/index.test.ts"],
      dir: "extensions",
      env: {},
    });

    expect(config.test?.include).toEqual(["browser/index.test.ts"]);
    expect(config.test?.passWithNoTests).toBe(true);
  });

  it("loads scoped include overrides from OPENCLAW_VITEST_INCLUDE_FILE", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-vitest-scoped-"));
    try {
      const includeFile = path.join(tempDir, "include.json");
      fs.writeFileSync(includeFile, JSON.stringify(["src/utils/utils-misc.test.ts"]), "utf8");

      const config = createScopedVitestConfig(["src/utils/**/*.test.ts"], {
        dir: "src",
        env: {
          OPENCLAW_VITEST_INCLUDE_FILE: includeFile,
        },
      });

      expect(config.test?.include).toEqual(["utils/utils-misc.test.ts"]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("overrides setup files when a scoped config requests them", () => {
    const config = createScopedVitestConfig(["src/example.test.ts"], {
      env: {},
      setupFiles: ["test/setup.extensions.ts"],
    });

    expect(config.test?.setupFiles).toEqual([
      "test/setup.ts",
      "test/setup.extensions.ts",
      "test/setup-openclaw-runtime.ts",
    ]);
  });
});

describe("scoped vitest configs", () => {
  const defaultChannelsConfig = createChannelsVitestConfig({});
  const defaultAcpConfig = createAcpVitestConfig({});
  const defaultCliConfig = createCliVitestConfig({});
  const defaultExtensionsConfig = createExtensionsVitestConfig({});
  const defaultExtensionAcpxConfig = createExtensionAcpxVitestConfig({});
  const defaultExtensionBlueBubblesConfig = createExtensionBlueBubblesVitestConfig({});
  const defaultExtensionChannelsConfig = createExtensionChannelsVitestConfig({});
  const defaultExtensionDiffsConfig = createExtensionDiffsVitestConfig({});
  const defaultExtensionFeishuConfig = createExtensionFeishuVitestConfig({});
  const defaultExtensionIrcConfig = createExtensionIrcVitestConfig({});
  const defaultExtensionMatrixConfig = createExtensionMatrixVitestConfig({});
  const defaultExtensionMattermostConfig = createExtensionMattermostVitestConfig({});
  const defaultExtensionMemoryConfig = createExtensionMemoryVitestConfig({});
  const defaultExtensionMsTeamsConfig = createExtensionMsTeamsVitestConfig({});
  const defaultExtensionMessagingConfig = createExtensionMessagingVitestConfig({});
  const defaultExtensionProvidersConfig = createExtensionProvidersVitestConfig({});
  const defaultExtensionTelegramConfig = createExtensionTelegramVitestConfig({});
  const defaultExtensionVoiceCallConfig = createExtensionVoiceCallVitestConfig({});
  const defaultExtensionWhatsAppConfig = createExtensionWhatsAppVitestConfig({});
  const defaultExtensionZaloConfig = createExtensionZaloVitestConfig({});
  const defaultGatewayConfig = createGatewayVitestConfig({});
  const defaultHooksConfig = createHooksVitestConfig({});
  const defaultInfraConfig = createInfraVitestConfig({});
  const defaultLoggingConfig = createLoggingVitestConfig({});
  const defaultPluginSdkConfig = createPluginSdkVitestConfig({});
  const defaultSecretsConfig = createSecretsVitestConfig({});
  const defaultRuntimeConfig = createRuntimeConfigVitestConfig({});
  const defaultCronConfig = createCronVitestConfig({});
  const defaultDaemonConfig = createDaemonVitestConfig({});
  const defaultMediaConfig = createMediaVitestConfig({});
  const defaultMediaUnderstandingConfig = createMediaUnderstandingVitestConfig({});
  const defaultSharedCoreConfig = createSharedCoreVitestConfig({});
  const defaultTasksConfig = createTasksVitestConfig({});
  const defaultCommandsConfig = createCommandsVitestConfig({});
  const defaultAutoReplyConfig = createAutoReplyVitestConfig({});
  const defaultAgentsConfig = createAgentsVitestConfig({});
  const defaultPluginsConfig = createPluginsVitestConfig({});
  const defaultProcessConfig = createProcessVitestConfig({});
  const defaultToolingConfig = createToolingVitestConfig({});
  const defaultTuiConfig = createTuiVitestConfig({});
  const defaultUiConfig = createUiVitestConfig({});
  const defaultUtilsConfig = createUtilsVitestConfig({});
  const defaultWizardConfig = createWizardVitestConfig({});

  it("keeps scoped lanes on threads with the shared non-isolated runner", () => {
    for (const config of [
      defaultChannelsConfig,
      defaultAcpConfig,
      defaultExtensionsConfig,
      defaultExtensionChannelsConfig,
      defaultExtensionProvidersConfig,
      defaultInfraConfig,
      defaultAutoReplyConfig,
      defaultToolingConfig,
      defaultUiConfig,
    ]) {
      expect(config.test?.pool).toBe("threads");
      expect(config.test?.isolate).toBe(false);
      expect(config.test?.runner).toBe("./test/non-isolated-runner.ts");
    }

    for (const config of [defaultGatewayConfig, defaultCommandsConfig, defaultAgentsConfig]) {
      expect(config.test?.pool).toBe("threads");
      expect(config.test?.isolate).toBe(false);
      expect(config.test?.runner).toBe("./test/non-isolated-runner.ts");
    }
  });

  it("keeps the process lane off the openclaw runtime setup", () => {
    expect(defaultProcessConfig.test?.setupFiles).toEqual(["test/setup.ts"]);
    expect(defaultPluginSdkConfig.test?.setupFiles).toEqual([
      "test/setup.ts",
      "test/setup-openclaw-runtime.ts",
    ]);
  });

  it("defaults channel tests to threads with the non-isolated runner", () => {
    expect(defaultChannelsConfig.test?.isolate).toBe(false);
    expect(defaultChannelsConfig.test?.pool).toBe("threads");
    expect(defaultChannelsConfig.test?.runner).toBe("./test/non-isolated-runner.ts");
  });

  it("keeps the core channel lane limited to non-extension roots", () => {
    expect(defaultChannelsConfig.test?.include).toEqual(["src/channels/**/*.test.ts"]);
  });

  it("loads channel include overrides from OPENCLAW_VITEST_INCLUDE_FILE", () => {
    const tempDirs: string[] = [];
    const tempDir = makeTempDir(tempDirs, "openclaw-vitest-channels-");
    try {
      const includeFile = path.join(tempDir, "include.json");
      fs.writeFileSync(
        includeFile,
        JSON.stringify([
          bundledPluginFile(
            "discord",
            "src/monitor/message-handler.preflight.acp-bindings.test.ts",
          ),
        ]),
        "utf8",
      );

      const config = createChannelsVitestConfig({
        OPENCLAW_VITEST_INCLUDE_FILE: includeFile,
      });

      expect(config.test?.include).toEqual([
        bundledPluginFile("discord", "src/monitor/message-handler.preflight.acp-bindings.test.ts"),
      ]);
    } finally {
      cleanupTempDirs(tempDirs);
    }
  });

  it("defaults extension tests to threads with the non-isolated runner", () => {
    expect(defaultExtensionsConfig.test?.isolate).toBe(false);
    expect(defaultExtensionsConfig.test?.pool).toBe("threads");
    expect(defaultExtensionsConfig.test?.runner).toBe("./test/non-isolated-runner.ts");
  });

  it("normalizes extension channel include patterns relative to the scoped dir", () => {
    expect(defaultExtensionChannelsConfig.test?.dir).toBe("extensions");
    expect(defaultExtensionChannelsConfig.test?.include).toEqual(
      expect.arrayContaining([
        "browser/**/*.test.ts",
        "discord/**/*.test.ts",
        "line/**/*.test.ts",
        "slack/**/*.test.ts",
        "signal/**/*.test.ts",
        "imessage/**/*.test.ts",
      ]),
    );
  });

  it("normalizes bluebubbles extension include patterns relative to the scoped dir", () => {
    expect(defaultExtensionBlueBubblesConfig.test?.dir).toBe("extensions");
    expect(defaultExtensionBlueBubblesConfig.test?.include).toEqual(["bluebubbles/**/*.test.ts"]);
  });

  it("normalizes acpx extension include patterns relative to the scoped dir", () => {
    expect(defaultExtensionAcpxConfig.test?.dir).toBe("extensions");
    expect(defaultExtensionAcpxConfig.test?.include).toEqual(["acpx/**/*.test.ts"]);
  });

  it("normalizes diffs extension include patterns relative to the scoped dir", () => {
    expect(defaultExtensionDiffsConfig.test?.dir).toBe("extensions");
    expect(defaultExtensionDiffsConfig.test?.include).toEqual(["diffs/**/*.test.ts"]);
  });

  it("normalizes feishu extension include patterns relative to the scoped dir", () => {
    expect(defaultExtensionFeishuConfig.test?.dir).toBe("extensions");
    expect(defaultExtensionFeishuConfig.test?.include).toEqual(["feishu/**/*.test.ts"]);
  });

  it("normalizes irc extension include patterns relative to the scoped dir", () => {
    expect(defaultExtensionIrcConfig.test?.dir).toBe("extensions");
    expect(defaultExtensionIrcConfig.test?.include).toEqual(["irc/**/*.test.ts"]);
  });

  it("normalizes extension include patterns relative to the scoped dir", () => {
    expect(defaultExtensionsConfig.test?.dir).toBe("extensions");
    expect(defaultExtensionsConfig.test?.include).toEqual(["**/*.test.ts"]);
  });

  it("normalizes extension provider include patterns relative to the scoped dir", () => {
    expect(defaultExtensionProvidersConfig.test?.dir).toBe("extensions");
    expect(defaultExtensionProvidersConfig.test?.include).toEqual(
      expect.arrayContaining(["openai/**/*.test.ts", "xai/**/*.test.ts", "google/**/*.test.ts"]),
    );
  });

  it("normalizes extension messaging include patterns relative to the scoped dir", () => {
    expect(defaultExtensionMessagingConfig.test?.dir).toBe("extensions");
    expect(defaultExtensionMessagingConfig.test?.include).toEqual(
      expect.arrayContaining(["googlechat/**/*.test.ts"]),
    );
  });

  it("normalizes matrix extension include patterns relative to the scoped dir", () => {
    expect(defaultExtensionMatrixConfig.test?.dir).toBe("extensions");
    expect(defaultExtensionMatrixConfig.test?.include).toEqual(["matrix/**/*.test.ts"]);
  });

  it("normalizes mattermost extension include patterns relative to the scoped dir", () => {
    expect(defaultExtensionMattermostConfig.test?.dir).toBe("extensions");
    expect(defaultExtensionMattermostConfig.test?.include).toEqual(["mattermost/**/*.test.ts"]);
  });

  it("normalizes msteams extension include patterns relative to the scoped dir", () => {
    expect(defaultExtensionMsTeamsConfig.test?.dir).toBe("extensions");
    expect(defaultExtensionMsTeamsConfig.test?.include).toEqual(["msteams/**/*.test.ts"]);
  });

  it("normalizes telegram extension include patterns relative to the scoped dir", () => {
    expect(defaultExtensionTelegramConfig.test?.dir).toBe("extensions");
    expect(defaultExtensionTelegramConfig.test?.include).toEqual(["telegram/**/*.test.ts"]);
  });

  it("normalizes whatsapp extension include patterns relative to the scoped dir", () => {
    expect(defaultExtensionWhatsAppConfig.test?.dir).toBe("extensions");
    expect(defaultExtensionWhatsAppConfig.test?.include).toEqual(["whatsapp/**/*.test.ts"]);
  });

  it("normalizes zalo extension include patterns relative to the scoped dir", () => {
    expect(defaultExtensionZaloConfig.test?.dir).toBe("extensions");
    expect(defaultExtensionZaloConfig.test?.include).toEqual(
      expect.arrayContaining(["zalo/**/*.test.ts", "zalouser/**/*.test.ts"]),
    );
  });

  it("normalizes voice-call extension include patterns relative to the scoped dir", () => {
    expect(defaultExtensionVoiceCallConfig.test?.dir).toBe("extensions");
    expect(defaultExtensionVoiceCallConfig.test?.include).toEqual(["voice-call/**/*.test.ts"]);
  });

  it("normalizes memory extension include patterns relative to the scoped dir", () => {
    expect(defaultExtensionMemoryConfig.test?.dir).toBe("extensions");
    expect(defaultExtensionMemoryConfig.test?.include).toEqual(
      expect.arrayContaining(["memory-core/**/*.test.ts", "memory-lancedb/**/*.test.ts"]),
    );
  });

  it("keeps telegram plugin tests out of the shared extensions lane", () => {
    const extensionExcludes = defaultExtensionsConfig.test?.exclude ?? [];
    expect(
      extensionExcludes.some((pattern) => path.matchesGlob("telegram/src/fetch.test.ts", pattern)),
    ).toBe(true);
    expect(
      extensionExcludes.some((pattern) =>
        path.matchesGlob("telegram/src/bot/delivery.resolve-media-retry.test.ts", pattern),
      ),
    ).toBe(true);
    expect(defaultChannelsConfig.test?.include).not.toContain("extensions/telegram/**/*.test.ts");
    expect(defaultChannelsConfig.test?.exclude).not.toContain(
      bundledPluginFile("telegram", "src/fetch.test.ts"),
    );
    expect(defaultExtensionsConfig.test?.setupFiles).toEqual([
      "test/setup.ts",
      "test/setup.extensions.ts",
      "test/setup-openclaw-runtime.ts",
    ]);
    expect(defaultExtensionTelegramConfig.test?.setupFiles).toEqual([
      "test/setup.ts",
      "test/setup.extensions.ts",
      "test/setup-openclaw-runtime.ts",
    ]);
  });

  it("keeps whatsapp tests out of the shared extensions lane", () => {
    const extensionExcludes = defaultExtensionsConfig.test?.exclude ?? [];
    expect(
      extensionExcludes.some((pattern) => path.matchesGlob("whatsapp/src/send.test.ts", pattern)),
    ).toBe(true);
  });

  it("keeps voice-call tests out of the shared extensions lane", () => {
    const extensionExcludes = defaultExtensionsConfig.test?.exclude ?? [];
    expect(
      extensionExcludes.some((pattern) =>
        path.matchesGlob("voice-call/src/runtime.test.ts", pattern),
      ),
    ).toBe(true);
  });

  it("keeps zalo tests out of the shared extensions lane", () => {
    const extensionExcludes = defaultExtensionsConfig.test?.exclude ?? [];
    expect(
      extensionExcludes.some((pattern) => path.matchesGlob("zalo/src/channel.test.ts", pattern)),
    ).toBe(true);
    expect(
      extensionExcludes.some((pattern) =>
        path.matchesGlob("zalouser/src/channel.test.ts", pattern),
      ),
    ).toBe(true);
  });

  it("keeps provider plugin tests out of the shared extensions lane", () => {
    const extensionExcludes = defaultExtensionsConfig.test?.exclude ?? [];
    expect(
      extensionExcludes.some((pattern) =>
        path.matchesGlob("openai/openai-codex-provider.test.ts", pattern),
      ),
    ).toBe(true);
  });

  it("keeps messaging plugin tests out of the shared extensions lane", () => {
    const extensionExcludes = defaultExtensionsConfig.test?.exclude ?? [];
    expect(
      extensionExcludes.some((pattern) => path.matchesGlob("matrix/src/channel.test.ts", pattern)),
    ).toBe(true);
  });

  it("keeps mattermost tests out of the shared extensions lane", () => {
    const extensionExcludes = defaultExtensionsConfig.test?.exclude ?? [];
    expect(
      extensionExcludes.some((pattern) =>
        path.matchesGlob("mattermost/src/channel.test.ts", pattern),
      ),
    ).toBe(true);
  });

  it("normalizes secrets include patterns relative to the scoped dir", () => {
    expect(defaultSecretsConfig.test?.dir).toBe("src/secrets");
    expect(defaultSecretsConfig.test?.include).toEqual(["**/*.test.ts"]);
  });

  it("normalizes hooks include patterns relative to the scoped dir", () => {
    expect(defaultHooksConfig.test?.dir).toBe("src/hooks");
    expect(defaultHooksConfig.test?.include).toEqual(["**/*.test.ts"]);
  });

  it("keeps memory plugin tests out of the shared extensions lane", () => {
    const extensionExcludes = defaultExtensionsConfig.test?.exclude ?? [];
    expect(
      extensionExcludes.some((pattern) =>
        path.matchesGlob("memory-core/src/memory/test-runtime-mocks.ts", pattern),
      ),
    ).toBe(true);
  });

  it("keeps bluebubbles tests out of the shared extensions lane", () => {
    const extensionExcludes = defaultExtensionsConfig.test?.exclude ?? [];
    expect(
      extensionExcludes.some((pattern) =>
        path.matchesGlob("bluebubbles/src/monitor.test.ts", pattern),
      ),
    ).toBe(true);
  });

  it("keeps feishu tests out of the shared extensions lane", () => {
    const extensionExcludes = defaultExtensionsConfig.test?.exclude ?? [];
    expect(
      extensionExcludes.some((pattern) => path.matchesGlob("feishu/src/channel.test.ts", pattern)),
    ).toBe(true);
  });

  it("keeps irc tests out of the shared extensions lane", () => {
    const extensionExcludes = defaultExtensionsConfig.test?.exclude ?? [];
    expect(
      extensionExcludes.some((pattern) => path.matchesGlob("irc/src/channel.test.ts", pattern)),
    ).toBe(true);
  });

  it("keeps acpx tests out of the shared extensions lane", () => {
    const extensionExcludes = defaultExtensionsConfig.test?.exclude ?? [];
    expect(
      extensionExcludes.some((pattern) => path.matchesGlob("acpx/src/runtime.test.ts", pattern)),
    ).toBe(true);
  });

  it("keeps diffs tests out of the shared extensions lane", () => {
    const extensionExcludes = defaultExtensionsConfig.test?.exclude ?? [];
    expect(
      extensionExcludes.some((pattern) => path.matchesGlob("diffs/src/render.test.ts", pattern)),
    ).toBe(true);
  });

  it("normalizes gateway include patterns relative to the scoped dir", () => {
    expect(defaultGatewayConfig.test?.dir).toBe("src/gateway");
    expect(defaultGatewayConfig.test?.include).toEqual(["**/*.test.ts"]);
  });

  it("normalizes infra include patterns relative to the scoped dir", () => {
    expect(defaultInfraConfig.test?.dir).toBe("src");
    expect(defaultInfraConfig.test?.include).toEqual(["infra/**/*.test.ts"]);
  });

  it("normalizes runtime config include patterns relative to the scoped dir", () => {
    expect(defaultRuntimeConfig.test?.dir).toBe("src");
    expect(defaultRuntimeConfig.test?.include).toEqual(["config/**/*.test.ts"]);
  });

  it("normalizes cron include patterns relative to the scoped dir", () => {
    expect(defaultCronConfig.test?.dir).toBe("src");
    expect(defaultCronConfig.test?.include).toEqual(["cron/**/*.test.ts"]);
  });

  it("normalizes daemon include patterns relative to the scoped dir", () => {
    expect(defaultDaemonConfig.test?.dir).toBe("src");
    expect(defaultDaemonConfig.test?.include).toEqual(["daemon/**/*.test.ts"]);
  });

  it("normalizes media include patterns relative to the scoped dir", () => {
    expect(defaultMediaConfig.test?.dir).toBe("src");
    expect(defaultMediaConfig.test?.include).toEqual(["media/**/*.test.ts"]);
  });

  it("normalizes logging include patterns relative to the scoped dir", () => {
    expect(defaultLoggingConfig.test?.dir).toBe("src");
    expect(defaultLoggingConfig.test?.include).toEqual(["logging/**/*.test.ts"]);
  });

  it("normalizes plugin-sdk include patterns relative to the scoped dir", () => {
    expect(defaultPluginSdkConfig.test?.dir).toBe("src");
    expect(defaultPluginSdkConfig.test?.include).toEqual(["plugin-sdk/**/*.test.ts"]);
  });

  it("normalizes shared-core include patterns relative to the scoped dir", () => {
    expect(defaultSharedCoreConfig.test?.dir).toBe("src");
    expect(defaultSharedCoreConfig.test?.include).toEqual(["shared/**/*.test.ts"]);
    expect(defaultSharedCoreConfig.test?.setupFiles).toEqual(["test/setup.ts"]);
  });

  it("normalizes process include patterns relative to the scoped dir", () => {
    expect(defaultProcessConfig.test?.dir).toBe("src");
    expect(defaultProcessConfig.test?.include).toEqual(["process/**/*.test.ts"]);
  });

  it("normalizes tasks include patterns relative to the scoped dir", () => {
    expect(defaultTasksConfig.test?.dir).toBe("src");
    expect(defaultTasksConfig.test?.include).toEqual(["tasks/**/*.test.ts"]);
  });

  it("normalizes wizard include patterns relative to the scoped dir", () => {
    expect(defaultWizardConfig.test?.dir).toBe("src");
    expect(defaultWizardConfig.test?.include).toEqual(["wizard/**/*.test.ts"]);
  });

  it("normalizes tui include patterns relative to the scoped dir", () => {
    expect(defaultTuiConfig.test?.dir).toBe("src");
    expect(defaultTuiConfig.test?.include).toEqual(["tui/**/*.test.ts"]);
  });

  it("normalizes media-understanding include patterns relative to the scoped dir", () => {
    expect(defaultMediaUnderstandingConfig.test?.dir).toBe("src");
    expect(defaultMediaUnderstandingConfig.test?.include).toEqual([
      "media-understanding/**/*.test.ts",
    ]);
  });

  it("keeps tooling tests in their own lane", () => {
    expect(defaultToolingConfig.test?.include).toEqual(
      expect.arrayContaining([
        "test/**/*.test.ts",
        "src/scripts/**/*.test.ts",
        "src/config/doc-baseline.integration.test.ts",
      ]),
    );
  });

  it("normalizes acp include patterns relative to the scoped dir", () => {
    expect(defaultAcpConfig.test?.dir).toBe("src/acp");
    expect(defaultAcpConfig.test?.include).toEqual(["**/*.test.ts"]);
  });

  it("normalizes cli include patterns relative to the scoped dir", () => {
    expect(defaultCliConfig.test?.dir).toBe("src/cli");
    expect(defaultCliConfig.test?.include).toEqual(["**/*.test.ts"]);
  });

  it("normalizes commands include patterns relative to the scoped dir", () => {
    expect(defaultCommandsConfig.test?.dir).toBe("src/commands");
    expect(defaultCommandsConfig.test?.include).toEqual(["**/*.test.ts"]);
  });

  it("normalizes auto-reply include patterns relative to the scoped dir", () => {
    expect(defaultAutoReplyConfig.test?.dir).toBe("src/auto-reply");
    expect(defaultAutoReplyConfig.test?.include).toEqual(["**/*.test.ts"]);
  });

  it("normalizes agents include patterns relative to the scoped dir", () => {
    expect(defaultAgentsConfig.test?.dir).toBe("src/agents");
    expect(defaultAgentsConfig.test?.include).toEqual(["**/*.test.ts"]);
  });

  it("normalizes plugins include patterns relative to the scoped dir", () => {
    expect(defaultPluginsConfig.test?.dir).toBe("src/plugins");
    expect(defaultPluginsConfig.test?.include).toEqual(["**/*.test.ts"]);
  });

  it("normalizes ui include patterns relative to the scoped dir", () => {
    expect(defaultUiConfig.test?.dir).toBe("ui/src/ui");
    expect(defaultUiConfig.test?.include).toEqual(["**/*.test.ts"]);
  });

  it("normalizes utils include patterns relative to the scoped dir", () => {
    expect(defaultUtilsConfig.test?.dir).toBe("src");
    expect(defaultUtilsConfig.test?.include).toEqual(["utils/**/*.test.ts"]);
    expect(defaultUtilsConfig.test?.setupFiles).toEqual(["test/setup.ts"]);
  });
});
