import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAcpVitestConfig } from "../vitest.acp.config.ts";
import { createAgentsVitestConfig } from "../vitest.agents.config.ts";
import { createAutoReplyVitestConfig } from "../vitest.auto-reply.config.ts";
import { createChannelsVitestConfig } from "../vitest.channels.config.ts";
import { createCommandsVitestConfig } from "../vitest.commands.config.ts";
import { createExtensionChannelsVitestConfig } from "../vitest.extension-channels.config.ts";
import { createExtensionsVitestConfig } from "../vitest.extensions.config.ts";
import { createGatewayVitestConfig } from "../vitest.gateway.config.ts";
import { createScopedVitestConfig, resolveVitestIsolation } from "../vitest.scoped-config.ts";
import { createUiVitestConfig } from "../vitest.ui.config.ts";
import { BUNDLED_PLUGIN_TEST_GLOB, bundledPluginFile } from "./helpers/bundled-plugin-paths.js";

const EXTENSIONS_CHANNEL_GLOB = ["extensions", "channel", "**"].join("/");

describe("resolveVitestIsolation", () => {
  it("defaults shared scoped configs to non-isolated workers", () => {
    expect(resolveVitestIsolation({})).toBe(false);
  });

  it("restores isolate mode when explicitly requested", () => {
    expect(resolveVitestIsolation({ OPENCLAW_TEST_ISOLATE: "1" })).toBe(true);
    expect(resolveVitestIsolation({ OPENCLAW_TEST_NO_ISOLATE: "0" })).toBe(true);
    expect(resolveVitestIsolation({ OPENCLAW_TEST_NO_ISOLATE: "false" })).toBe(true);
  });
});

describe("createScopedVitestConfig", () => {
  it("applies non-isolated mode by default", () => {
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

  it("overrides setup files when a scoped config requests them", () => {
    const config = createScopedVitestConfig(["src/example.test.ts"], {
      env: {},
      setupFiles: ["test/setup.extensions.ts"],
    });

    expect(config.test?.setupFiles).toEqual(["test/setup.extensions.ts"]);
  });
});

describe("scoped vitest configs", () => {
  const defaultChannelsConfig = createChannelsVitestConfig({});
  const defaultAcpConfig = createAcpVitestConfig({});
  const defaultExtensionsConfig = createExtensionsVitestConfig({});
  const defaultExtensionChannelsConfig = createExtensionChannelsVitestConfig({});
  const defaultGatewayConfig = createGatewayVitestConfig({});
  const defaultCommandsConfig = createCommandsVitestConfig({});
  const defaultAutoReplyConfig = createAutoReplyVitestConfig({});
  const defaultAgentsConfig = createAgentsVitestConfig({});
  const defaultUiConfig = createUiVitestConfig({});

  it("defaults channel tests to non-isolated mode", () => {
    expect(defaultChannelsConfig.test?.isolate).toBe(false);
    expect(defaultChannelsConfig.test?.pool).toBe("forks");
  });

  it("keeps the core channel lane limited to non-extension roots", () => {
    expect(defaultChannelsConfig.test?.include).toEqual([
      "src/browser/**/*.test.ts",
      "src/line/**/*.test.ts",
    ]);
  });

  it("loads channel include overrides from OPENCLAW_VITEST_INCLUDE_FILE", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-vitest-channels-"));
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
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("defaults extension tests to non-isolated mode", () => {
    expect(defaultExtensionsConfig.test?.isolate).toBe(false);
    expect(defaultExtensionsConfig.test?.pool).toBe("forks");
  });

  it("normalizes extension channel include patterns relative to the scoped dir", () => {
    expect(defaultExtensionChannelsConfig.test?.dir).toBe("extensions");
    expect(defaultExtensionChannelsConfig.test?.include).toEqual([
      "discord/**/*.test.ts",
      "whatsapp/**/*.test.ts",
      "slack/**/*.test.ts",
      "signal/**/*.test.ts",
      "imessage/**/*.test.ts",
    ]);
  });

  it("normalizes extension include patterns relative to the scoped dir", () => {
    expect(defaultExtensionsConfig.test?.dir).toBe("extensions");
    expect(defaultExtensionsConfig.test?.include).toEqual(["**/*.test.ts"]);
  });

  it("keeps telegram plugin tests in extensions while excluding channel-surface plugin roots", () => {
    const extensionExcludes = defaultExtensionsConfig.test?.exclude ?? [];
    expect(
      extensionExcludes.some((pattern) => path.matchesGlob("telegram/src/fetch.test.ts", pattern)),
    ).toBe(false);
    expect(
      extensionExcludes.some((pattern) =>
        path.matchesGlob("telegram/src/bot/delivery.resolve-media-retry.test.ts", pattern),
      ),
    ).toBe(false);
    expect(defaultChannelsConfig.test?.include).not.toContain("extensions/telegram/**/*.test.ts");
    expect(defaultChannelsConfig.test?.exclude).not.toContain(
      bundledPluginFile("telegram", "src/fetch.test.ts"),
    );
    expect(defaultExtensionsConfig.test?.setupFiles).toEqual(["test/setup.extensions.ts"]);
  });

  it("normalizes gateway include patterns relative to the scoped dir", () => {
    expect(defaultGatewayConfig.test?.dir).toBe("src/gateway");
    expect(defaultGatewayConfig.test?.include).toEqual(["**/*.test.ts"]);
  });

  it("normalizes acp include patterns relative to the scoped dir", () => {
    expect(defaultAcpConfig.test?.dir).toBe("src/acp");
    expect(defaultAcpConfig.test?.include).toEqual(["**/*.test.ts"]);
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

  it("normalizes ui include patterns relative to the scoped dir", () => {
    expect(defaultUiConfig.test?.dir).toBe("ui/src/ui");
    expect(defaultUiConfig.test?.include).toEqual(["**/*.test.ts"]);
  });
});
