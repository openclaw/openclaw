import { describe, expect, it } from "vitest";
import { type OpenClawConfig, DEFAULT_GATEWAY_PORT } from "../config/config.js";
import {
  buildDefaultHookUrl,
  buildGwsWatchArgs,
  buildTopicPath,
  parseTopicPath,
  resolveGmailHookRuntimeConfig,
} from "./gmail.js";

const baseConfig = {
  hooks: {
    token: "hook-token",
    gmail: {
      account: "openclaw@gmail.com",
      topic: "projects/demo/topics/gog-gmail-watch",
      pushToken: "push-token",
    },
  },
} satisfies OpenClawConfig;

describe("gmail hook config", () => {
  function resolveWithGmailOverrides(
    overrides: Partial<NonNullable<OpenClawConfig["hooks"]>["gmail"]>,
  ) {
    return resolveGmailHookRuntimeConfig(
      {
        hooks: {
          token: "hook-token",
          gmail: {
            account: "openclaw@gmail.com",
            topic: "projects/demo/topics/gog-gmail-watch",
            pushToken: "push-token",
            ...overrides,
          },
        },
      },
      {},
    );
  }

  function expectResolvedPaths(
    result: ReturnType<typeof resolveGmailHookRuntimeConfig>,
    expected: { servePath: string; publicPath: string; target?: string },
  ) {
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.serve.path).toBe(expected.servePath);
    expect(result.value.tailscale.path).toBe(expected.publicPath);
    if (expected.target !== undefined) {
      expect(result.value.tailscale.target).toBe(expected.target);
    }
  }

  it("builds default hook url", () => {
    expect(buildDefaultHookUrl("/hooks", DEFAULT_GATEWAY_PORT)).toBe(
      `http://127.0.0.1:${DEFAULT_GATEWAY_PORT}/hooks/gmail`,
    );
  });

  it("parses topic path", () => {
    const topic = buildTopicPath("proj", "topic");
    expect(parseTopicPath(topic)).toEqual({
      projectId: "proj",
      topicName: "topic",
    });
  });

  it("resolves runtime config with defaults", () => {
    const result = resolveGmailHookRuntimeConfig(baseConfig, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.account).toBe("openclaw@gmail.com");
      expect(result.value.label).toBe("INBOX");
      expect(result.value.includeBody).toBe(true);
      expect(result.value.serve.port).toBe(8788);
      expect(result.value.hookUrl).toBe(`http://127.0.0.1:${DEFAULT_GATEWAY_PORT}/hooks/gmail`);
    }
  });

  it("fails without hook token", () => {
    const result = resolveGmailHookRuntimeConfig(
      {
        hooks: {
          gmail: {
            account: "openclaw@gmail.com",
            topic: "projects/demo/topics/gog-gmail-watch",
            pushToken: "push-token",
          },
        },
      },
      {},
    );
    expect(result.ok).toBe(false);
  });

  it("defaults serve path to / when tailscale is enabled", () => {
    const result = resolveWithGmailOverrides({ tailscale: { mode: "funnel" } });
    expectResolvedPaths(result, { servePath: "/", publicPath: "/gmail-pubsub" });
  });

  it("keeps the default public path when serve path is explicit", () => {
    const result = resolveWithGmailOverrides({
      serve: { path: "/gmail-pubsub" },
      tailscale: { mode: "funnel" },
    });
    expectResolvedPaths(result, { servePath: "/", publicPath: "/gmail-pubsub" });
  });

  it("keeps custom public path when serve path is set", () => {
    const result = resolveWithGmailOverrides({
      serve: { path: "/custom" },
      tailscale: { mode: "funnel" },
    });
    expectResolvedPaths(result, { servePath: "/", publicPath: "/custom" });
  });

  it("keeps serve path when tailscale target is set", () => {
    const target = "http://127.0.0.1:8788/custom";
    const result = resolveWithGmailOverrides({
      serve: { path: "/custom" },
      tailscale: { mode: "funnel", target },
    });
    expectResolvedPaths(result, { servePath: "/custom", publicPath: "/custom", target });
  });

  it("defaults cli to gog", () => {
    const result = resolveGmailHookRuntimeConfig(baseConfig, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.cli).toBe("gog");
    }
  });

  it("resolves cli from config", () => {
    const result = resolveGmailHookRuntimeConfig(
      {
        hooks: {
          token: "hook-token",
          gmail: {
            cli: "gws",
            account: "openclaw@gmail.com",
          },
        },
      },
      {},
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.cli).toBe("gws");
    }
  });

  it("resolves cli from overrides", () => {
    const result = resolveGmailHookRuntimeConfig(baseConfig, { cli: "gws" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.cli).toBe("gws");
    }
  });

  it("does not require pushToken for gws", () => {
    const result = resolveGmailHookRuntimeConfig(
      {
        hooks: {
          token: "hook-token",
          gmail: {
            cli: "gws",
            account: "openclaw@gmail.com",
          },
        },
      },
      {},
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.pushToken).toBe("");
    }
  });

  it("does not require topic for gws", () => {
    const result = resolveGmailHookRuntimeConfig(
      {
        hooks: {
          token: "hook-token",
          gmail: {
            cli: "gws",
            account: "openclaw@gmail.com",
          },
        },
      },
      {},
    );
    expect(result.ok).toBe(true);
  });

  it("still requires pushToken for gog", () => {
    const result = resolveGmailHookRuntimeConfig(
      {
        hooks: {
          token: "hook-token",
          gmail: {
            account: "openclaw@gmail.com",
            topic: "projects/demo/topics/gog-gmail-watch",
          },
        },
      },
      {},
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("push token");
    }
  });

  it("resolves project from config", () => {
    const result = resolveGmailHookRuntimeConfig(
      {
        hooks: {
          token: "hook-token",
          gmail: {
            cli: "gws",
            project: "my-project",
            account: "openclaw@gmail.com",
          },
        },
      },
      {},
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.project).toBe("my-project");
    }
  });
});

describe("buildGwsWatchArgs", () => {
  it("builds basic args with project and account", () => {
    const args = buildGwsWatchArgs({
      account: "openclaw@gmail.com",
      label: "INBOX",
      project: "my-project",
      subscription: "gog-gmail-watch-push",
    });
    expect(args).toEqual([
      "gmail",
      "+watch",
      "--project",
      "my-project",
      "--account",
      "openclaw@gmail.com",
    ]);
  });

  it("includes label when not INBOX", () => {
    const args = buildGwsWatchArgs({
      account: "openclaw@gmail.com",
      label: "IMPORTANT",
      project: "my-project",
      subscription: "gog-gmail-watch-push",
    });
    expect(args).toContain("--label");
    expect(args).toContain("IMPORTANT");
  });

  it("includes subscription when non-default", () => {
    const args = buildGwsWatchArgs({
      account: "openclaw@gmail.com",
      label: "INBOX",
      project: "my-project",
      subscription: "custom-sub",
    });
    expect(args).toContain("--subscription");
    expect(args).toContain("custom-sub");
  });

  it("omits project when not set", () => {
    const args = buildGwsWatchArgs({
      account: "openclaw@gmail.com",
      label: "INBOX",
      project: undefined,
      subscription: "gog-gmail-watch-push",
    });
    expect(args).not.toContain("--project");
  });
});
