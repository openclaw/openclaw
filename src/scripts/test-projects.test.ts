import { describe, expect, it } from "vitest";

const { buildVitestArgs, buildVitestRunPlans, createVitestRunSpecs, parseTestProjectsArgs } =
  (await import("../../scripts/test-projects.test-support.mjs")) as unknown as {
    buildVitestArgs: (args: string[], cwd?: string) => string[];
    buildVitestRunPlans: (
      args: string[],
      cwd?: string,
    ) => Array<{
      config: string;
      forwardedArgs: string[];
      includePatterns: string[] | null;
      watchMode: boolean;
    }>;
    createVitestRunSpecs: (
      args: string[],
      params?: {
        baseEnv?: NodeJS.ProcessEnv;
        cwd?: string;
        tempDir?: string;
      },
    ) => Array<{
      config: string;
      env: NodeJS.ProcessEnv;
      includeFilePath: string | null;
      includePatterns: string[] | null;
      pnpmArgs: string[];
      watchMode: boolean;
    }>;
    parseTestProjectsArgs: (
      args: string[],
      cwd?: string,
    ) => {
      forwardedArgs: string[];
      targetArgs: string[];
      watchMode: boolean;
    };
  };

describe("test-projects args", () => {
  it("drops a pnpm passthrough separator while preserving targeted filters", () => {
    expect(parseTestProjectsArgs(["--", "src/foo.test.ts", "-t", "target"])).toEqual({
      forwardedArgs: ["src/foo.test.ts", "-t", "target"],
      targetArgs: ["src/foo.test.ts"],
      watchMode: false,
    });
  });

  it("keeps watch mode explicit without leaking the sentinel to Vitest", () => {
    expect(buildVitestArgs(["--watch", "--", "src/foo.test.ts"])).toEqual([
      "exec",
      "vitest",
      "--config",
      "vitest.unit.config.ts",
      "src/foo.test.ts",
    ]);
  });

  it("uses run mode by default", () => {
    expect(buildVitestArgs(["src/foo.test.ts"])).toEqual([
      "exec",
      "vitest",
      "run",
      "--config",
      "vitest.unit.config.ts",
      "src/foo.test.ts",
    ]);
  });

  it("routes boundary targets to the boundary config", () => {
    expect(buildVitestRunPlans(["src/infra/openclaw-root.test.ts"])).toEqual([
      {
        config: "vitest.boundary.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/infra/openclaw-root.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes bundled-plugin-dependent unit targets to the bundled config", () => {
    expect(buildVitestRunPlans(["src/plugins/loader.test.ts"])).toEqual([
      {
        config: "vitest.bundled.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/plugins/loader.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes top-level repo tests to the contracts config", () => {
    expect(buildVitestRunPlans(["test/appcast.test.ts"])).toEqual([
      {
        config: "vitest.tooling.config.ts",
        forwardedArgs: [],
        includePatterns: ["test/appcast.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes script tests to the tooling config", () => {
    expect(buildVitestRunPlans(["src/scripts/test-projects.test.ts"])).toEqual([
      {
        config: "vitest.tooling.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/scripts/test-projects.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes contract tests to the contracts config", () => {
    expect(
      buildVitestRunPlans(["src/plugins/contracts/memory-embedding-provider.contract.test.ts"]),
    ).toEqual([
      {
        config: "vitest.contracts.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/plugins/contracts/memory-embedding-provider.contract.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes config baseline integration tests to the contracts config", () => {
    expect(buildVitestRunPlans(["src/config/doc-baseline.integration.test.ts"])).toEqual([
      {
        config: "vitest.tooling.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/config/doc-baseline.integration.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes runtime config targets to the runtime-config config", () => {
    expect(buildVitestRunPlans(["src/config/sessions.test.ts"])).toEqual([
      {
        config: "vitest.runtime-config.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/config/sessions.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes cron targets to the cron config", () => {
    expect(buildVitestRunPlans(["src/cron/isolated-agent.lane.test.ts"])).toEqual([
      {
        config: "vitest.cron.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/cron/isolated-agent.lane.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes daemon targets to the daemon config", () => {
    expect(buildVitestRunPlans(["src/daemon/constants.test.ts"])).toEqual([
      {
        config: "vitest.daemon.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/daemon/constants.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes media targets to the media config", () => {
    expect(buildVitestRunPlans(["src/media/mime.test.ts"])).toEqual([
      {
        config: "vitest.media.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/media/mime.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes plugin-sdk targets to the plugin-sdk config", () => {
    expect(buildVitestRunPlans(["src/plugin-sdk/provider-stream.test.ts"])).toEqual([
      {
        config: "vitest.plugin-sdk.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/plugin-sdk/provider-stream.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes process targets to the process config", () => {
    expect(buildVitestRunPlans(["src/process/exec.test.ts"])).toEqual([
      {
        config: "vitest.process.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/process/exec.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes secrets targets to the secrets config", () => {
    expect(buildVitestRunPlans(["src/secrets/resolve.test.ts"])).toEqual([
      {
        config: "vitest.secrets.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/secrets/resolve.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes shared-core targets to the shared-core config", () => {
    expect(buildVitestRunPlans(["src/shared/text-chunking.test.ts"])).toEqual([
      {
        config: "vitest.shared-core.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/shared/text-chunking.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes tasks targets to the tasks config", () => {
    expect(buildVitestRunPlans(["src/tasks/task-registry.test.ts"])).toEqual([
      {
        config: "vitest.tasks.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/tasks/task-registry.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes logging targets to the logging config", () => {
    expect(buildVitestRunPlans(["src/logging/load-levels.test.ts"])).toEqual([
      {
        config: "vitest.logging.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/logging/load-levels.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes wizard targets to the wizard config", () => {
    expect(buildVitestRunPlans(["src/wizard/setup.test.ts"])).toEqual([
      {
        config: "vitest.wizard.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/wizard/setup.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes tui targets to the tui config", () => {
    expect(buildVitestRunPlans(["src/tui/tui.test.ts"])).toEqual([
      {
        config: "vitest.tui.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/tui/tui.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes media-understanding targets to the media-understanding config", () => {
    expect(buildVitestRunPlans(["src/media-understanding/runtime.test.ts"])).toEqual([
      {
        config: "vitest.media-understanding.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/media-understanding/runtime.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes command targets to the commands config", () => {
    expect(buildVitestRunPlans(["src/commands/status.summary.test.ts"])).toEqual([
      {
        config: "vitest.commands.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/commands/status.summary.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes auto-reply targets to the auto-reply config", () => {
    expect(buildVitestRunPlans(["src/auto-reply/reply/get-reply.message-hooks.test.ts"])).toEqual([
      {
        config: "vitest.auto-reply.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/auto-reply/reply/get-reply.message-hooks.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes agents targets to the agents config", () => {
    expect(buildVitestRunPlans(["src/agents/tools/image-tool.test.ts"])).toEqual([
      {
        config: "vitest.agents.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/agents/tools/image-tool.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes gateway targets to the gateway config", () => {
    expect(buildVitestRunPlans(["src/gateway/call.test.ts"])).toEqual([
      {
        config: "vitest.gateway.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/gateway/call.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes hooks targets to the hooks config", () => {
    expect(buildVitestRunPlans(["src/hooks/install.test.ts"])).toEqual([
      {
        config: "vitest.hooks.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/hooks/install.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes channel targets to the channels config", () => {
    expect(buildVitestRunPlans(["src/channels/ids.test.ts"])).toEqual([
      {
        config: "vitest.channels.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/channels/ids.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes infra targets to the infra config", () => {
    expect(buildVitestRunPlans(["src/infra/openclaw-root.test.ts"])).toEqual([
      {
        config: "vitest.boundary.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/infra/openclaw-root.test.ts"],
        watchMode: false,
      },
    ]);

    expect(buildVitestRunPlans(["src/infra/migrations.test.ts"])).toEqual([
      {
        config: "vitest.infra.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/infra/migrations.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes acp targets to the acp config", () => {
    expect(buildVitestRunPlans(["src/acp/control-plane/manager.test.ts"])).toEqual([
      {
        config: "vitest.acp.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/acp/control-plane/manager.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes cli targets to the cli config", () => {
    expect(buildVitestRunPlans(["src/cli/test-runtime-capture.test.ts"])).toEqual([
      {
        config: "vitest.cli.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/cli/test-runtime-capture.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes plugin targets to the plugins config", () => {
    expect(buildVitestRunPlans(["src/plugins/loader.test.ts"])).toEqual([
      {
        config: "vitest.bundled.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/plugins/loader.test.ts"],
        watchMode: false,
      },
    ]);

    expect(buildVitestRunPlans(["src/plugins/discovery.test.ts"])).toEqual([
      {
        config: "vitest.plugins.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/plugins/discovery.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("widens non-test helper file targets to sibling tests inside the routed suite", () => {
    expect(buildVitestRunPlans(["src/gateway/gateway-connection.test-mocks.ts"])).toEqual([
      {
        config: "vitest.gateway.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/gateway/**/*.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("widens extension helper targets to sibling extension tests", () => {
    expect(
      buildVitestRunPlans(["extensions/memory-core/src/memory/test-runtime-mocks.ts"]),
    ).toEqual([
      {
        config: "vitest.extension-memory.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/memory-core/src/memory/**/*.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes msteams extension tests to the msteams config", () => {
    expect(buildVitestRunPlans(["extensions/msteams/src/config.test.ts"])).toEqual([
      {
        config: "vitest.extension-msteams.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/msteams/src/config.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes telegram extension tests to the telegram config", () => {
    expect(buildVitestRunPlans(["extensions/telegram/src/fetch.test.ts"])).toEqual([
      {
        config: "vitest.extension-telegram.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/telegram/src/fetch.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes whatsapp extension tests to the whatsapp config", () => {
    expect(buildVitestRunPlans(["extensions/whatsapp/src/send.test.ts"])).toEqual([
      {
        config: "vitest.extension-whatsapp.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/whatsapp/src/send.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes voice-call extension tests to the voice-call config", () => {
    expect(buildVitestRunPlans(["extensions/voice-call/src/runtime.test.ts"])).toEqual([
      {
        config: "vitest.extension-voice-call.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/voice-call/src/runtime.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes mattermost extension tests to the mattermost config", () => {
    expect(buildVitestRunPlans(["extensions/mattermost/src/channel.test.ts"])).toEqual([
      {
        config: "vitest.extension-mattermost.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/mattermost/src/channel.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes zalo extension tests to the zalo config", () => {
    expect(buildVitestRunPlans(["extensions/zalo/src/channel.test.ts"])).toEqual([
      {
        config: "vitest.extension-zalo.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/zalo/src/channel.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes matrix extension tests to the matrix config", () => {
    expect(buildVitestRunPlans(["extensions/matrix/src/channel.test.ts"])).toEqual([
      {
        config: "vitest.extension-matrix.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/matrix/src/channel.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes bluebubbles extension tests to the bluebubbles config", () => {
    expect(buildVitestRunPlans(["extensions/bluebubbles/src/monitor.test.ts"])).toEqual([
      {
        config: "vitest.extension-bluebubbles.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/bluebubbles/src/monitor.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes feishu extension tests to the feishu config", () => {
    expect(buildVitestRunPlans(["extensions/feishu/src/channel.test.ts"])).toEqual([
      {
        config: "vitest.extension-feishu.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/feishu/src/channel.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes irc extension tests to the irc config", () => {
    expect(buildVitestRunPlans(["extensions/irc/src/channel.test.ts"])).toEqual([
      {
        config: "vitest.extension-irc.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/irc/src/channel.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes acpx extension tests to the acpx config", () => {
    expect(buildVitestRunPlans(["extensions/acpx/src/runtime.test.ts"])).toEqual([
      {
        config: "vitest.extension-acpx.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/acpx/src/runtime.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes diffs extension tests to the diffs config", () => {
    expect(buildVitestRunPlans(["extensions/diffs/src/render.test.ts"])).toEqual([
      {
        config: "vitest.extension-diffs.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/diffs/src/render.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes ui targets to the ui config", () => {
    expect(buildVitestRunPlans(["ui/src/ui/views/channels.test.ts"])).toEqual([
      {
        config: "vitest.ui.config.ts",
        forwardedArgs: [],
        includePatterns: ["ui/src/ui/views/channels.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes utils targets to the utils config", () => {
    expect(buildVitestRunPlans(["src/utils/path.test.ts"])).toEqual([
      {
        config: "vitest.utils.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/utils/path.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("widens top-level test helpers to sibling repo tests under contracts", () => {
    expect(buildVitestRunPlans(["test/helpers/temp-home.ts"])).toEqual([
      {
        config: "vitest.tooling.config.ts",
        forwardedArgs: [],
        includePatterns: ["test/helpers/**/*.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes e2e targets straight to the e2e config", () => {
    expect(buildVitestRunPlans(["src/commands/models.set.e2e.test.ts"])).toEqual([
      {
        config: "vitest.e2e.config.ts",
        forwardedArgs: ["src/commands/models.set.e2e.test.ts"],
        includePatterns: null,
        watchMode: false,
      },
    ]);
  });

  it("routes direct channel extension file targets to the channels config", () => {
    expect(
      buildVitestRunPlans(["extensions/discord/src/monitor/message-handler.preflight.test.ts"]),
    ).toEqual([
      {
        config: "vitest.extension-channels.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/discord/src/monitor/message-handler.preflight.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes browser extension targets to the extension channel config", () => {
    expect(buildVitestRunPlans(["extensions/browser/index.test.ts"])).toEqual([
      {
        config: "vitest.extension-channels.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/browser/index.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes line extension targets to the extension channel config", () => {
    expect(buildVitestRunPlans(["extensions/line/src/send.test.ts"])).toEqual([
      {
        config: "vitest.extension-channels.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/line/src/send.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes matrix extension file targets to the matrix config", () => {
    expect(buildVitestRunPlans(["extensions/matrix/src/channel.test.ts"])).toEqual([
      {
        config: "vitest.extension-matrix.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/matrix/src/channel.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes direct provider extension file targets to the extension providers config", () => {
    expect(buildVitestRunPlans(["extensions/openai/openai-codex-provider.test.ts"])).toEqual([
      {
        config: "vitest.extension-providers.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/openai/openai-codex-provider.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("keeps non-provider extension file targets on the shared extensions config", () => {
    expect(buildVitestRunPlans(["extensions/firecrawl/index.test.ts"])).toEqual([
      {
        config: "vitest.extensions.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/firecrawl/index.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("splits mixed core and extension targets into separate vitest runs", () => {
    expect(
      buildVitestRunPlans([
        "src/config/config-misc.test.ts",
        "extensions/discord/src/monitor/message-handler.preflight.test.ts",
        "-t",
        "mention",
      ]),
    ).toEqual([
      {
        config: "vitest.runtime-config.config.ts",
        forwardedArgs: ["-t", "mention"],
        includePatterns: ["src/config/config-misc.test.ts"],
        watchMode: false,
      },
      {
        config: "vitest.extension-channels.config.ts",
        forwardedArgs: ["-t", "mention"],
        includePatterns: ["extensions/discord/src/monitor/message-handler.preflight.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("writes scoped include files for routed extension runs", () => {
    const [spec] = createVitestRunSpecs([
      "extensions/discord/src/monitor/message-handler.preflight.test.ts",
    ]);

    expect(spec?.pnpmArgs).toEqual([
      "exec",
      "vitest",
      "run",
      "--config",
      "vitest.extension-channels.config.ts",
    ]);
    expect(spec?.includePatterns).toEqual([
      "extensions/discord/src/monitor/message-handler.preflight.test.ts",
    ]);
    expect(spec?.includeFilePath).toContain("openclaw-vitest-include-");
    expect(spec?.env.OPENCLAW_VITEST_INCLUDE_FILE).toBe(spec?.includeFilePath);
  });

  it("rejects watch mode when a command spans multiple suites", () => {
    expect(() =>
      buildVitestRunPlans([
        "--watch",
        "src/config/config-misc.test.ts",
        "extensions/discord/src/monitor/message-handler.preflight.test.ts",
      ]),
    ).toThrow("watch mode with mixed test suites is not supported");
  });
});
