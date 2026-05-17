import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type OpenClawConfig, DEFAULT_GATEWAY_PORT } from "../config/config.js";
import {
  buildDefaultHookUrl,
  buildGogWatchServeLogArgs,
  buildTopicPath,
  parseTopicPath,
  resolveGmailHookRuntimeConfig,
  resolveGmailSetupHookToken,
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

  it("builds watch serve log args without secrets", () => {
    const result = resolveGmailHookRuntimeConfig(baseConfig, {});
    expect(result.ok).toBe(true);
    if (!result.ok) {
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

  it("resolves hook token from tokenFile", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gmail-token-"));
    const tokenFile = path.join(dir, "hooks.token");
    fs.writeFileSync(tokenFile, "file-hook-token\n", { mode: 0o600 });
    try {
      const result = resolveGmailHookRuntimeConfig(
        {
          hooks: {
            tokenFile,
            gmail: {
              account: "openclaw@gmail.com",
              topic: "projects/demo/topics/gog-gmail-watch",
              pushToken: "push-token",
            },
          },
        },
        {},
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.hookToken).toBe("file-hook-token");
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves tokenFile when setup resolves an existing file-backed token", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gmail-setup-token-"));
    const tokenFile = path.join(dir, "hooks.token");
    fs.writeFileSync(tokenFile, "file-hook-token\n", { mode: 0o600 });
    try {
      const result = resolveGmailSetupHookToken({ tokenFile });
      expect(result.hookToken).toBe("file-hook-token");
      expect(result.hooksAuth).toEqual({ token: undefined, tokenFile });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses inline setup hook token overrides instead of tokenFile", () => {
    const result = resolveGmailSetupHookToken(
      { tokenFile: "/run/secrets/openclaw-hooks-token" },
      "override-token",
    );
    expect(result).toEqual({
      hookToken: "override-token",
      hooksAuth: { token: "override-token", tokenFile: undefined },
    });
  });

  it("keeps an existing inline token when setup has no override", () => {
    const result = resolveGmailSetupHookToken({ token: "existing-token" });
    expect(result).toEqual({
      hookToken: "existing-token",
      hooksAuth: { token: "existing-token", tokenFile: undefined },
    });
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
