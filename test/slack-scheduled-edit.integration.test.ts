import { afterEach, describe, expect, it, vi } from "vitest";
import { slackPlugin } from "../extensions/slack/api.js";
import { dispatchChannelMessageAction } from "../src/channels/plugins/message-action-dispatch.js";
import type { OpenClawConfig } from "../src/config/config.js";
import { withServer } from "../src/plugin-sdk/test-helpers/http-test-server.js";
import { createPluginRegistry } from "../src/plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../src/plugins/runtime.js";
import type { PluginRuntime } from "../src/plugins/runtime/types.js";
import { createPluginRecord } from "../src/plugins/status.test-fixtures.js";

type Dispatch = Parameters<typeof dispatchChannelMessageAction>[0];

function setup(baseUrl: string) {
  for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) {
    vi.stubEnv(name, undefined);
  }
  vi.stubEnv("NO_PROXY", "*");
  vi.stubEnv("SLACK_API_URL", `${baseUrl}/api/`);
  const cfg: OpenClawConfig = {
    channels: {
      slack: {
        botToken: "xoxb-scheduled-edit-fixture",
        groupPolicy: "allowlist",
        dangerouslyAllowNameMatching: true,
        channels: { "#allowed": { enabled: true } },
      },
    },
  };
  const registry = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({ id: "slack", origin: "bundled" });
  registry.registry.plugins.push(record);
  registry
    .createApi(record, { config: cfg, registrationMode: "full" })
    .registerChannel({ plugin: slackPlugin });
  setActivePluginRegistry(registry.registry);
  const lifetime = new AbortController();
  const context: Dispatch = {
    cfg,
    channel: "slack",
    action: "edit",
    accountId: "default",
    params: { channelId: "C_TARGET", messageId: "123.45", message: "Updated status" },
    messageActionAuthorization: {
      scheduled: {
        policy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:main:owner",
          ownerAccountId: "default",
          ownerOrigin: { kind: "external", channel: "slack" },
        },
        assertCurrent: () => lifetime.signal.throwIfAborted(),
      },
    },
  };
  return { context, lifetime };
}

afterEach(() => {
  resetPluginRuntimeStateForTest();
  vi.unstubAllEnvs();
});

describe("scheduled Slack edits through the registered adapter and HTTP client", () => {
  it.each(["allowed", "revoke-after-lookup", "revoke-before-retry"] as const)(
    "fences %s at the request boundary",
    async (scenario) => {
      const requests: string[] = [];
      let lifetime: AbortController;
      await withServer(
        (request, response) => {
          const route = request.url ?? "";
          requests.push(route);
          request.resume();
          if (route === "/api/conversations.info") {
            if (scenario === "revoke-after-lookup") {
              lifetime.abort(new Error("job revoked"));
            }
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
              JSON.stringify({ ok: true, channel: { id: "C_TARGET", name: "allowed" } }),
            );
          } else if (scenario === "revoke-before-retry") {
            lifetime.abort(new Error("job revoked"));
            response.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
            response.end(JSON.stringify({ ok: false, error: "ratelimited" }));
          } else {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ ok: true, channel: "C_TARGET", ts: "123.45" }));
          }
        },
        async (baseUrl) => {
          const fixture = setup(baseUrl);
          lifetime = fixture.lifetime;
          const result = dispatchChannelMessageAction(fixture.context);
          if (scenario === "allowed") {
            await expect(result).resolves.toMatchObject({ details: { ok: true } });
          } else {
            await expect(result).rejects.toThrow("job revoked");
          }
          expect(requests).toEqual(
            scenario === "revoke-after-lookup"
              ? ["/api/conversations.info"]
              : ["/api/conversations.info", "/api/chat.update"],
          );
        },
      );
    },
  );

  it.each(["unknown origin", "other provider", "other account", "revoked"] as const)(
    "rejects %s before HTTP",
    async (scenario) => {
      const requests: string[] = [];
      await withServer(
        (request, response) => {
          requests.push(request.url ?? "");
          request.resume();
          response.end("{}");
        },
        async (baseUrl) => {
          const { context, lifetime } = setup(baseUrl);
          const scheduled = context.messageActionAuthorization?.scheduled;
          if (!scheduled || scheduled.policy.mode !== "account") {
            throw new Error("missing scheduled fixture");
          }
          if (scenario === "unknown origin") {
            scheduled.policy.ownerOrigin = { kind: "unknown" };
          }
          if (scenario === "other provider") {
            scheduled.policy.ownerOrigin = { kind: "external", channel: "discord" };
          }
          if (scenario === "other account") {
            scheduled.policy.ownerAccountId = "other";
          }
          if (scenario === "revoked") {
            lifetime.abort(new Error("job revoked"));
          }
          await expect(dispatchChannelMessageAction(context)).rejects.toThrow();
          expect(requests).toEqual([]);
        },
      );
    },
  );
});
