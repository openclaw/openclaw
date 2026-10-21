import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  buildGogWatchServeArgs,
  buildGogWatchServeLogArgs,
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
        hooks: { ...baseConfig.hooks, gmail: { ...baseConfig.hooks.gmail, ...overrides } },
      },
      {},
    );
  }

  it("parses topic path", () => {
    const topic = buildTopicPath("proj", "topic");
    expect(parseTopicPath(topic)).toEqual({ projectId: "proj", topicName: "topic" });
  });

  it("builds watch serve log args without secrets", () => {
    const result = resolveGmailHookRuntimeConfig(baseConfig, {});
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const serveArgs = buildGogWatchServeArgs(result.value);
    expect(serveArgs).toContain("--exclude-labels");
    expect(serveArgs[serveArgs.indexOf("--exclude-labels") + 1]).toBe("SPAM,TRASH,DRAFT,SENT");

    const args = buildGogWatchServeLogArgs(result.value);
    // --token, --hook-url, and --hook-token are stripped from the log args.
    expect(args).toEqual(
      (
        "gmail watch serve --account openclaw@gmail.com --bind 127.0.0.1 --port 8788 " +
        "--path /gmail-pubsub --include-body --exclude-labels SPAM,TRASH,DRAFT,SENT " +
        "--max-bytes 20000"
      ).split(" "),
    );
  });

  it("fails without hook token", () => {
    const result = resolveGmailHookRuntimeConfig({ hooks: { gmail: baseConfig.hooks.gmail } }, {});
    expect(result.ok).toBe(false);
  });

  it("keeps custom public path when serve path is set", () => {
    const result = resolveWithGmailOverrides({
      serve: { path: "/custom" },
      tailscale: { mode: "funnel" },
    });
    expect(result).toMatchObject({
      ok: true,
      value: { serve: { path: "/" }, tailscale: { path: "/custom" } },
    });
  });
});
