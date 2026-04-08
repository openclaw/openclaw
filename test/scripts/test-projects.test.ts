import { describe, expect, it } from "vitest";
import {
  buildFullSuiteVitestRunPlans,
  buildVitestRunPlans,
  resolveChangedTargetArgs,
} from "../../scripts/test-projects.test-support.mjs";

describe("scripts/test-projects changed-target routing", () => {
  it("maps changed source files into scoped lane targets", () => {
    expect(
      resolveChangedTargetArgs(["--changed", "origin/main"], process.cwd(), () => [
        "src/shared/string-normalization.ts",
        "src/utils/provider-utils.ts",
      ]),
    ).toEqual(["src/shared/string-normalization.ts", "src/utils/provider-utils.ts"]);
  });

  it("keeps the broad changed run for Vitest wiring edits", () => {
    expect(
      resolveChangedTargetArgs(["--changed", "origin/main"], process.cwd(), () => [
        "vitest.shared.config.ts",
        "src/utils/provider-utils.ts",
      ]),
    ).toBeNull();
  });

  it("ignores changed files that cannot map to test lanes", () => {
    expect(
      resolveChangedTargetArgs(["--changed", "origin/main"], process.cwd(), () => [
        "docs/help/testing.md",
      ]),
    ).toBeNull();
  });

  it("narrows default-lane changed source files to include globs", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "packages/sdk/src/index.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "vitest.unit.config.ts",
        forwardedArgs: [],
        includePatterns: ["packages/sdk/src/**/*.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes changed utils and shared files to their light scoped lanes", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "src/shared/string-normalization.ts",
      "src/utils/provider-utils.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "vitest.unit-fast.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/shared/string-normalization.test.ts"],
        watchMode: false,
      },
      {
        config: "vitest.utils.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/utils/**/*.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes explicit plugin-sdk light tests to the lighter plugin-sdk lane", () => {
    const plans = buildVitestRunPlans(["src/plugin-sdk/temp-path.test.ts"], process.cwd());

    expect(plans).toEqual([
      {
        config: "vitest.plugin-sdk-light.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/plugin-sdk/temp-path.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes explicit commands light tests to the lighter commands lane", () => {
    const plans = buildVitestRunPlans(["src/commands/status-json-runtime.test.ts"], process.cwd());

    expect(plans).toEqual([
      {
        config: "vitest.commands-light.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/commands/status-json-runtime.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes unit-fast light tests to the cache-friendly unit-fast lane", () => {
    const plans = buildVitestRunPlans(
      ["src/commands/status-overview-values.test.ts"],
      process.cwd(),
    );

    expect(plans).toEqual([
      {
        config: "vitest.unit-fast.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/commands/status-overview-values.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes changed plugin-sdk source allowlist files to sibling light tests", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "src/plugin-sdk/provider-entry.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "vitest.unit-fast.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/plugin-sdk/provider-entry.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes changed commands source allowlist files to sibling light tests", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "src/commands/status-overview-values.ts",
      "src/commands/gateway-status/helpers.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "vitest.unit-fast.config.ts",
        forwardedArgs: [],
        includePatterns: [
          "src/commands/status-overview-values.test.ts",
          "src/commands/gateway-status/helpers.test.ts",
        ],
        watchMode: false,
      },
    ]);
  });

  it("keeps non-allowlisted plugin-sdk source files on the heavy lane", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "src/plugin-sdk/facade-runtime.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "vitest.plugin-sdk.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/plugin-sdk/**/*.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("keeps non-allowlisted commands source files on the heavy lane", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "src/commands/channels.add.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "vitest.commands.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/commands/**/*.test.ts"],
        watchMode: false,
      },
    ]);
  });
});

describe("scripts/test-projects full-suite sharding", () => {
  it("splits untargeted runs into fixed shard configs", () => {
    delete process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS;

    expect(buildFullSuiteVitestRunPlans([], process.cwd()).map((plan) => plan.config)).toEqual([
      "vitest.full-core-unit-fast.config.ts",
      "vitest.full-core-unit-src.config.ts",
      "vitest.full-core-unit-security.config.ts",
      "vitest.full-core-unit-ui.config.ts",
      "vitest.full-core-unit-support.config.ts",
      "vitest.full-core-support-boundary.config.ts",
      "vitest.full-core-contracts.config.ts",
      "vitest.full-core-bundled.config.ts",
      "vitest.full-core-runtime.config.ts",
      "vitest.full-agentic.config.ts",
      "vitest.full-auto-reply.config.ts",
      "vitest.full-extensions.config.ts",
    ]);
  });

  it("can expand full-suite shards to project configs for perf experiments", () => {
    const previous = process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS;
    process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS = "1";
    const plans = buildFullSuiteVitestRunPlans([], process.cwd());
    if (previous === undefined) {
      delete process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS;
    } else {
      process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS = previous;
    }

    expect(plans.map((plan) => plan.config)).toEqual([
      "vitest.unit-fast.config.ts",
      "vitest.unit-src.config.ts",
      "vitest.unit-security.config.ts",
      "vitest.unit-ui.config.ts",
      "vitest.unit-support.config.ts",
      "vitest.boundary.config.ts",
      "vitest.tooling.config.ts",
      "vitest.contracts.config.ts",
      "vitest.bundled.config.ts",
      "vitest.infra.config.ts",
      "vitest.hooks.config.ts",
      "vitest.acp.config.ts",
      "vitest.runtime-config.config.ts",
      "vitest.secrets.config.ts",
      "vitest.logging.config.ts",
      "vitest.process.config.ts",
      "vitest.cron.config.ts",
      "vitest.media.config.ts",
      "vitest.media-understanding.config.ts",
      "vitest.shared-core.config.ts",
      "vitest.tasks.config.ts",
      "vitest.tui.config.ts",
      "vitest.ui.config.ts",
      "vitest.utils.config.ts",
      "vitest.wizard.config.ts",
      "vitest.gateway.config.ts",
      "vitest.cli.config.ts",
      "vitest.commands-light.config.ts",
      "vitest.commands.config.ts",
      "vitest.agents.config.ts",
      "vitest.daemon.config.ts",
      "vitest.plugin-sdk-light.config.ts",
      "vitest.plugin-sdk.config.ts",
      "vitest.plugins.config.ts",
      "vitest.channels.config.ts",
      "vitest.auto-reply-core.config.ts",
      "vitest.auto-reply-top-level.config.ts",
      "vitest.auto-reply-reply.config.ts",
      "vitest.extension-acpx.config.ts",
      "vitest.extension-bluebubbles.config.ts",
      "vitest.extension-channels.config.ts",
      "vitest.extension-diffs.config.ts",
      "vitest.extension-feishu.config.ts",
      "vitest.extension-irc.config.ts",
      "vitest.extension-mattermost.config.ts",
      "vitest.extension-matrix.config.ts",
      "vitest.extension-memory.config.ts",
      "vitest.extension-messaging.config.ts",
      "vitest.extension-msteams.config.ts",
      "vitest.extension-providers.config.ts",
      "vitest.extension-telegram.config.ts",
      "vitest.extension-voice-call.config.ts",
      "vitest.extension-whatsapp.config.ts",
      "vitest.extension-zalo.config.ts",
      "vitest.extensions.config.ts",
    ]);
    expect(plans).toEqual(
      plans.map((plan) => ({
        config: plan.config,
        forwardedArgs: [],
        includePatterns: null,
        watchMode: false,
      })),
    );
  });

  it("keeps untargeted watch mode on the native root config", () => {
    expect(buildFullSuiteVitestRunPlans(["--watch"], process.cwd())).toEqual([
      {
        config: "vitest.config.ts",
        forwardedArgs: [],
        includePatterns: null,
        watchMode: true,
      },
    ]);
  });
});
