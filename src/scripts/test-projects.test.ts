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
        config: "vitest.extensions.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/memory-core/src/memory/**/*.test.ts"],
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
        config: "vitest.channels.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/discord/src/monitor/message-handler.preflight.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes direct provider extension file targets to the extensions config", () => {
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
        config: "vitest.unit.config.ts",
        forwardedArgs: ["-t", "mention", "src/config/config-misc.test.ts"],
        includePatterns: null,
        watchMode: false,
      },
      {
        config: "vitest.channels.config.ts",
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
      "vitest.channels.config.ts",
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
