// Gmail hook tests cover Gmail hook configuration and setup helpers.
import { describe, expect, it } from "vitest";
import { type OpenClawConfig, DEFAULT_GATEWAY_PORT } from "../config/config.js";
import {
  buildDefaultHookUrl,
  buildGogWatchPullLogArgs,
  buildGogWatchServeLogArgs,
  buildTopicPath,
  isGmailHookPullRuntimeConfig,
  isGmailHookPushRuntimeConfig,
  parseSubscriptionPath,
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
    expect(result.value.delivery.mode).toBe("push");
    if (!isGmailHookPushRuntimeConfig(result.value)) {
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

  it("parses subscription path", () => {
    expect(parseSubscriptionPath("projects/proj/subscriptions/sub")).toEqual({
      projectId: "proj",
      subscriptionName: "sub",
    });
    expect(parseSubscriptionPath("sub")).toBeNull();
  });

  it("resolves runtime config with defaults", () => {
    const result = resolveGmailHookRuntimeConfig(baseConfig, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.account).toBe("openclaw@gmail.com");
      expect(result.value.delivery.mode).toBe("push");
      expect(result.value.label).toBe("INBOX");
      expect(result.value.includeBody).toBe(true);
      if (!isGmailHookPushRuntimeConfig(result.value)) {
        return;
      }
      expect(result.value.serve.port).toBe(8788);
      expect(result.value.hookUrl).toBe(`http://127.0.0.1:${DEFAULT_GATEWAY_PORT}/hooks/gmail`);
    }
  });

  it("resolves pull delivery without push token or callback server settings", () => {
    const result = resolveGmailHookRuntimeConfig(
      {
        hooks: {
          token: "hook-token",
          gmail: {
            account: "openclaw@gmail.com",
            topic: "projects/demo/topics/gog-gmail-watch",
            delivery: {
              mode: "pull",
              subscription: "projects/demo/subscriptions/gog-gmail-watch",
            },
          },
        },
      },
      {},
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.delivery).toEqual({
      mode: "pull",
      subscription: "projects/demo/subscriptions/gog-gmail-watch",
    });
    expect("pushToken" in result.value).toBe(false);
    expect("serve" in result.value).toBe(false);
    expect("tailscale" in result.value).toBe(false);
  });

  it("requires a full Pub/Sub subscription path for pull delivery", () => {
    const result = resolveGmailHookRuntimeConfig(
      {
        hooks: {
          token: "hook-token",
          gmail: {
            account: "openclaw@gmail.com",
            topic: "projects/demo/topics/gog-gmail-watch",
            subscription: "gog-gmail-watch",
            delivery: { mode: "pull" },
          },
        },
      },
      {},
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("full Pub/Sub path");
    }
  });

  it("builds watch serve log args without secrets", () => {
    const result = resolveGmailHookRuntimeConfig(baseConfig, {});
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.delivery.mode).toBe("push");
    if (!isGmailHookPushRuntimeConfig(result.value)) {
      return;
    }

    const args = buildGogWatchServeLogArgs(result.value);
    expect(args).not.toContain("push-token");
    expect(args).not.toContain("hook-token");
    expect(args).not.toContain("--token");
    expect(args).not.toContain("--hook-token");
    // --token, --hook-url, and --hook-token are stripped from the log args.
    expect(args).toEqual([
      "gmail",
      "watch",
      "serve",
      "--account",
      "openclaw@gmail.com",
      "--bind",
      "127.0.0.1",
      "--port",
      "8788",
      "--path",
      "/gmail-pubsub",
      "--include-body",
      "--max-bytes",
      "20000",
    ]);
  });

  it("builds watch pull log args without hook secrets", () => {
    const result = resolveGmailHookRuntimeConfig(
      {
        hooks: {
          token: "hook-token",
          gmail: {
            account: "openclaw@gmail.com",
            topic: "projects/demo/topics/gog-gmail-watch",
            delivery: {
              mode: "pull",
              subscription: "projects/demo/subscriptions/gog-gmail-watch",
            },
          },
        },
      },
      {},
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.delivery.mode).toBe("pull");
    if (!isGmailHookPullRuntimeConfig(result.value)) {
      return;
    }

    const args = buildGogWatchPullLogArgs(result.value);
    expect(args).not.toContain("hook-token");
    expect(args).not.toContain("--hook-token");
    expect(args).not.toContain("--hook-url");
    expect(args).toEqual([
      "gmail",
      "watch",
      "pull",
      "--account",
      "openclaw@gmail.com",
      "--subscription",
      "projects/demo/subscriptions/gog-gmail-watch",
      "--include-body",
      "--max-bytes",
      "20000",
    ]);
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
});
