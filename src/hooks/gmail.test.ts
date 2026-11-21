import { expect, it } from "vitest";
import {
  buildGogWatchServeArgs,
  buildGogWatchServeLogArgs,
  buildTopicPath,
  GMAIL_WATCH_PUSH_TOKEN_ENV,
  GMAIL_WATCH_HOOK_TOKEN_ENV,
  parseTopicPath,
  resolveGmailHookRuntimeConfig,
} from "./gmail.js";
import { createGmailConfig } from "./gmail.test-support.js";

const baseConfig = createGmailConfig("openclaw@gmail.com");

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

  expect(serveArgs).toContain(GMAIL_WATCH_PUSH_TOKEN_ENV);
  expect(serveArgs).toContain(GMAIL_WATCH_HOOK_TOKEN_ENV);
  expect(serveArgs).not.toContain(result.value.pushToken);
  expect(serveArgs).not.toContain(result.value.hookToken);
  expect(buildGogWatchServeArgs(result.value, "legacy-argv")).toEqual(
    expect.arrayContaining([
      "--token",
      result.value.pushToken,
      "--hook-token",
      result.value.hookToken,
    ]),
  );
  const args = buildGogWatchServeLogArgs(result.value);
  for (const mode of ["env", "legacy-argv"] as const) {
    const logged = buildGogWatchServeLogArgs(result.value, mode);
    for (const secret of [result.value.pushToken, result.value.hookToken, result.value.hookUrl]) {
      expect(logged).not.toContain(secret);
    }
  }
  expect(args).toEqual(
    (
      "gmail watch serve --account openclaw@gmail.com --bind 127.0.0.1 --port 8788 " +
      "--path /gmail-pubsub --token-env OPENCLAW_GOG_WATCH_PUSH_TOKEN " +
      "--hook-token-env OPENCLAW_GOG_WATCH_HOOK_TOKEN --include-body --exclude-labels SPAM,TRASH,DRAFT,SENT " +
      "--max-bytes 20000"
    ).split(" "),
  );
});

it("fails without hook token", () => {
  const result = resolveGmailHookRuntimeConfig({ hooks: { gmail: baseConfig.hooks?.gmail } }, {});
  expect(result.ok).toBe(false);
});

it("keeps custom public path when serve path is set", () => {
  const result = resolveGmailHookRuntimeConfig(
    {
      hooks: {
        ...baseConfig.hooks,
        gmail: {
          ...baseConfig.hooks?.gmail,
          serve: { path: "/custom" },
          tailscale: { mode: "funnel" },
        },
      },
    },
    {},
  );
  expect(result).toMatchObject({
    ok: true,
    value: { serve: { path: "/" }, tailscale: { path: "/custom" } },
  });
});
