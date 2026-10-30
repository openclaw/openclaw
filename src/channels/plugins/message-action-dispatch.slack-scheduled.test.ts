import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScheduledToolPolicyContext } from "../../agents/scheduled-tool-policy.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withServer } from "../../plugin-sdk/test-helpers/http-test-server.js";
import { createPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { createPluginRecord } from "../../plugins/status.test-fixtures.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { dispatchChannelMessageAction } from "./message-action-dispatch.js";
import type { ChannelPlugin } from "./types.public.js";

const { slackPlugin } = await loadBundledPluginFacade<{ slackPlugin: ChannelPlugin }>({
  pluginId: "slack",
  artifactBasename: "channel-plugin-api.ts",
});

const BOT_TOKEN = "xoxb-scheduled-edit-fixture";
const MESSAGE_ID = "171234.1";
const OWNER_POLICY: ScheduledToolPolicyContext = {
  version: 1,
  mode: "account",
  ownerSessionKey: "agent:main:slack:channel:C_CREATOR",
  ownerAccountId: "default",
  ownerOrigin: { kind: "external", channel: "slack" },
};

function registerSlack(baseUrl: string): OpenClawConfig {
  for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"] as const) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv("NO_PROXY", "*");
  vi.stubEnv("SLACK_API_URL", `${baseUrl}/api/`);
  const cfg: OpenClawConfig = {
    channels: {
      slack: {
        botToken: BOT_TOKEN,
        actions: { messages: true },
        groupPolicy: "allowlist",
        channels: { "#allowed": { enabled: true } },
        dangerouslyAllowNameMatching: true,
      },
    },
  };
  const owner = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({ id: "slack", origin: "bundled" });
  owner.registry.plugins.push(record);
  owner.createApi(record, { config: cfg, registrationMode: "full" }).registerChannel({
    plugin: slackPlugin,
  });
  setActivePluginRegistry(owner.registry);
  return cfg;
}

function scheduledEdit(
  cfg: OpenClawConfig,
  source: AbortController,
  options: {
    policy?: ScheduledToolPolicyContext;
    accountId?: string;
    channelId?: string;
    presentation?: Record<string, unknown>;
  } = {},
) {
  return dispatchChannelMessageAction({
    cfg,
    channel: "slack",
    action: "edit",
    accountId: options.accountId ?? "default",
    params: {
      channelId: options.channelId ?? "C_TARGET",
      messageId: MESSAGE_ID,
      message: "Updated status",
      presentation: options.presentation,
    },
    messageActionAuthorization: {
      scheduled: {
        policy: options.policy ?? OWNER_POLICY,
        assertCurrent: () => source.signal.throwIfAborted(),
      },
    },
  });
}

function sendSlackResponse(response: ServerResponse, payload: object): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

afterEach(() => {
  resetPluginRuntimeStateForTest();
  vi.unstubAllEnvs();
});

describe("scheduled Slack edits through the registered adapter", () => {
  it.each([
    "active",
    "lookup-revoked",
    "retry-revoked",
    "fallback-revoked",
    "accepted-then-revoked",
  ] as const)(
    "preserves live job authority at the actual Slack request boundary (%s)",
    async (outcome) => {
      const source = new AbortController();
      const paths: string[] = [];
      const writes: URLSearchParams[] = [];
      const authorization: (string | undefined)[] = [];
      await withServer(
        (request, response) => {
          const path = request.url ?? "";
          paths.push(path);
          authorization.push(request.headers.authorization);
          if (path === "/api/conversations.info") {
            request.resume();
            if (outcome === "lookup-revoked") {
              source.abort(new Error("scheduled edit authority revoked"));
            }
            sendSlackResponse(response, {
              ok: true,
              channel: { id: "C_TARGET", name: "allowed" },
            });
            return;
          }
          let body = "";
          request.setEncoding("utf8");
          request.on("data", (chunk: string) => {
            body += chunk;
          });
          request.on("end", () => {
            writes.push(new URLSearchParams(body));
            if (
              outcome === "retry-revoked" ||
              outcome === "fallback-revoked" ||
              outcome === "accepted-then-revoked"
            ) {
              source.abort(new Error("scheduled edit authority revoked"));
            }
            if (outcome === "retry-revoked") {
              response.writeHead(429, {
                "content-type": "application/json",
                "retry-after": "0",
              });
              response.end(JSON.stringify({ ok: false, error: "ratelimited" }));
            } else if (outcome === "fallback-revoked") {
              sendSlackResponse(response, { ok: false, error: "invalid_blocks" });
            } else {
              sendSlackResponse(response, { ok: true, channel: "C_TARGET", ts: MESSAGE_ID });
            }
          });
        },
        async (baseUrl) => {
          const operation = scheduledEdit(
            registerSlack(baseUrl),
            source,
            outcome === "fallback-revoked"
              ? {
                  presentation: {
                    blocks: [
                      {
                        type: "table",
                        caption: "Scheduled status",
                        headers: ["Status"],
                        rows: [["Healthy"]],
                      },
                    ],
                  },
                }
              : {},
          );
          if (
            outcome === "lookup-revoked" ||
            outcome === "retry-revoked" ||
            outcome === "fallback-revoked"
          ) {
            await expect(operation).rejects.toThrow("scheduled edit authority revoked");
          } else {
            await expect(operation).resolves.toMatchObject({ details: { ok: true } });
          }
          expect(paths).toEqual(
            outcome === "lookup-revoked"
              ? ["/api/conversations.info"]
              : ["/api/conversations.info", "/api/chat.update"],
          );
          expect(authorization).toEqual(paths.map(() => `Bearer ${BOT_TOKEN}`));
          expect(writes.map((body) => Object.fromEntries(body))).toEqual(
            outcome === "lookup-revoked"
              ? []
              : [
                  expect.objectContaining({
                    channel: "C_TARGET",
                    ts: MESSAGE_ID,
                    text: expect.stringContaining("Updated status"),
                  }),
                ],
          );
          if (outcome === "fallback-revoked") {
            expect(JSON.parse(writes[0]?.get("blocks") ?? "[]")).toEqual(
              expect.arrayContaining([expect.objectContaining({ type: "data_table" })]),
            );
          }
        },
      );
    },
  );

  it.each([
    {
      name: "unknown origin",
      policy: { ...OWNER_POLICY, ownerOrigin: { kind: "unknown" } },
      error: "matching recorded creator origin",
    },
    {
      name: "another provider",
      policy: { ...OWNER_POLICY, ownerOrigin: { kind: "external", channel: "discord" } },
      error: "matching recorded creator origin",
    },
    { name: "another account", accountId: "other", error: "another creator account" },
    { name: "revoked job", revoked: true, error: "scheduled edit authority revoked" },
  ] satisfies {
    name: string;
    policy?: ScheduledToolPolicyContext;
    accountId?: string;
    revoked?: boolean;
    error: string;
  }[])(
    "rejects $name before any provider request",
    async ({ policy, accountId, revoked, error }) => {
      const source = new AbortController();
      const paths: string[] = [];
      if (revoked) {
        source.abort(new Error("scheduled edit authority revoked"));
      }
      await withServer(
        (request, response) => {
          paths.push(request.url ?? "");
          request.resume();
          sendSlackResponse(response, { ok: true });
        },
        async (baseUrl) => {
          await expect(
            scheduledEdit(registerSlack(baseUrl), source, { policy, accountId }),
          ).rejects.toThrow(error);
          expect(paths).toEqual([]);
        },
      );
    },
  );

  it("retains the account's delegated channel allowlist", async () => {
    const paths: string[] = [];
    await withServer(
      (request, response) => {
        paths.push(request.url ?? "");
        request.resume();
        sendSlackResponse(response, {
          ok: true,
          channel: { id: "C_DENIED", name: "not-allowed" },
        });
      },
      async (baseUrl) => {
        await expect(
          scheduledEdit(registerSlack(baseUrl), new AbortController(), { channelId: "C_DENIED" }),
        ).rejects.toThrow("Slack read target channel is not allowed");
        expect(paths).toEqual(["/api/conversations.info"]);
      },
    );
  });
});
