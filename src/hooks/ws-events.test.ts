import { describe, expect, it } from "vitest";
import { type OpenClawConfig, DEFAULT_GATEWAY_PORT } from "../config/config.js";
import {
  buildDefaultWsEventsHookUrl,
  buildGwsEventsSubscribeArgs,
  DEFAULT_WS_EVENTS_MAX_MESSAGES,
  DEFAULT_WS_EVENTS_POLL_INTERVAL,
  resolveWsEventsHookRuntimeConfig,
} from "./ws-events.js";

const baseConfig = {
  hooks: {
    token: "hook-token",
    workspaceEvents: {
      project: "my-project",
      target: "//chat.googleapis.com/spaces/ABC",
      eventTypes: ["google.workspace.chat.message.v1.created"],
    },
  },
} satisfies OpenClawConfig;

describe("ws-events hook config", () => {
  it("builds default hook url", () => {
    expect(buildDefaultWsEventsHookUrl("/hooks", DEFAULT_GATEWAY_PORT)).toBe(
      `http://127.0.0.1:${DEFAULT_GATEWAY_PORT}/hooks/workspace-events`,
    );
  });

  it("resolves runtime config with defaults", () => {
    const result = resolveWsEventsHookRuntimeConfig(baseConfig, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.project).toBe("my-project");
      expect(result.value.target).toBe("//chat.googleapis.com/spaces/ABC");
      expect(result.value.eventTypes).toEqual(["google.workspace.chat.message.v1.created"]);
      expect(result.value.pollInterval).toBe(DEFAULT_WS_EVENTS_POLL_INTERVAL);
      expect(result.value.maxMessages).toBe(DEFAULT_WS_EVENTS_MAX_MESSAGES);
      expect(result.value.cleanup).toBe(false);
      expect(result.value.hookUrl).toBe(
        `http://127.0.0.1:${DEFAULT_GATEWAY_PORT}/hooks/workspace-events`,
      );
    }
  });

  it("fails without hook token", () => {
    const result = resolveWsEventsHookRuntimeConfig(
      {
        hooks: {
          workspaceEvents: {
            project: "my-project",
            target: "//chat.googleapis.com/spaces/ABC",
            eventTypes: ["google.workspace.chat.message.v1.created"],
          },
        },
      },
      {},
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("hooks.token");
    }
  });

  it("fails without project", () => {
    const result = resolveWsEventsHookRuntimeConfig(
      {
        hooks: {
          token: "hook-token",
          workspaceEvents: {
            target: "//chat.googleapis.com/spaces/ABC",
            eventTypes: ["google.workspace.chat.message.v1.created"],
          },
        },
      },
      {},
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("project");
    }
  });

  it("fails without target", () => {
    const result = resolveWsEventsHookRuntimeConfig(
      {
        hooks: {
          token: "hook-token",
          workspaceEvents: {
            project: "my-project",
            eventTypes: ["google.workspace.chat.message.v1.created"],
          },
        },
      },
      {},
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("target");
    }
  });

  it("fails without event types", () => {
    const result = resolveWsEventsHookRuntimeConfig(
      {
        hooks: {
          token: "hook-token",
          workspaceEvents: {
            project: "my-project",
            target: "//chat.googleapis.com/spaces/ABC",
          },
        },
      },
      {},
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("eventTypes");
    }
  });

  it("applies overrides", () => {
    const result = resolveWsEventsHookRuntimeConfig(baseConfig, {
      project: "override-project",
      target: "//drive.googleapis.com/files/X",
      eventTypes: ["google.workspace.drive.file.v1.updated"],
      subscription: "my-sub",
      pollInterval: 10,
      maxMessages: 5,
      cleanup: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.project).toBe("override-project");
      expect(result.value.target).toBe("//drive.googleapis.com/files/X");
      expect(result.value.eventTypes).toEqual(["google.workspace.drive.file.v1.updated"]);
      expect(result.value.subscription).toBe("my-sub");
      expect(result.value.pollInterval).toBe(10);
      expect(result.value.maxMessages).toBe(5);
      expect(result.value.cleanup).toBe(true);
    }
  });
});

describe("buildGwsEventsSubscribeArgs", () => {
  it("builds basic args", () => {
    const args = buildGwsEventsSubscribeArgs({
      target: "//chat.googleapis.com/spaces/ABC",
      eventTypes: ["google.workspace.chat.message.v1.created"],
      project: "my-project",
      pollInterval: DEFAULT_WS_EVENTS_POLL_INTERVAL,
      maxMessages: DEFAULT_WS_EVENTS_MAX_MESSAGES,
      cleanup: false,
    });
    expect(args).toEqual([
      "events",
      "+subscribe",
      "--target",
      "//chat.googleapis.com/spaces/ABC",
      "--event-types",
      "google.workspace.chat.message.v1.created",
      "--project",
      "my-project",
    ]);
  });

  it("includes subscription when set", () => {
    const args = buildGwsEventsSubscribeArgs({
      target: "//chat.googleapis.com/spaces/ABC",
      eventTypes: ["google.workspace.chat.message.v1.created"],
      project: "my-project",
      subscription: "my-sub",
      pollInterval: DEFAULT_WS_EVENTS_POLL_INTERVAL,
      maxMessages: DEFAULT_WS_EVENTS_MAX_MESSAGES,
      cleanup: false,
    });
    expect(args).toContain("--subscription");
    expect(args).toContain("my-sub");
  });

  it("includes non-default poll interval", () => {
    const args = buildGwsEventsSubscribeArgs({
      target: "//chat.googleapis.com/spaces/ABC",
      eventTypes: ["google.workspace.chat.message.v1.created"],
      project: "my-project",
      pollInterval: 10,
      maxMessages: DEFAULT_WS_EVENTS_MAX_MESSAGES,
      cleanup: false,
    });
    expect(args).toContain("--poll-interval");
    expect(args).toContain("10");
  });

  it("includes non-default max messages", () => {
    const args = buildGwsEventsSubscribeArgs({
      target: "//chat.googleapis.com/spaces/ABC",
      eventTypes: ["google.workspace.chat.message.v1.created"],
      project: "my-project",
      pollInterval: DEFAULT_WS_EVENTS_POLL_INTERVAL,
      maxMessages: 20,
      cleanup: false,
    });
    expect(args).toContain("--max-messages");
    expect(args).toContain("20");
  });

  it("includes cleanup flag", () => {
    const args = buildGwsEventsSubscribeArgs({
      target: "//chat.googleapis.com/spaces/ABC",
      eventTypes: ["google.workspace.chat.message.v1.created"],
      project: "my-project",
      pollInterval: DEFAULT_WS_EVENTS_POLL_INTERVAL,
      maxMessages: DEFAULT_WS_EVENTS_MAX_MESSAGES,
      cleanup: true,
    });
    expect(args).toContain("--cleanup");
  });

  it("joins multiple event types with comma", () => {
    const args = buildGwsEventsSubscribeArgs({
      target: "//chat.googleapis.com/spaces/ABC",
      eventTypes: [
        "google.workspace.chat.message.v1.created",
        "google.workspace.chat.message.v1.updated",
      ],
      project: "my-project",
      pollInterval: DEFAULT_WS_EVENTS_POLL_INTERVAL,
      maxMessages: DEFAULT_WS_EVENTS_MAX_MESSAGES,
      cleanup: false,
    });
    const idx = args.indexOf("--event-types");
    expect(args[idx + 1]).toBe(
      "google.workspace.chat.message.v1.created,google.workspace.chat.message.v1.updated",
    );
  });
});
