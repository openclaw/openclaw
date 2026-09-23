import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { feishuPlugin } from "../extensions/feishu/api.js";
import { createMessageTool } from "../src/agents/tools/message-tool-execution.js";
import { setRuntimeConfigSnapshot } from "../src/config/runtime-snapshot.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../src/gateway/message-action-turn-capability.js";
import { PlatformMessageNotDispatchedError } from "../src/infra/outbound/deliver-types.js";
import { runMessageAction } from "../src/infra/outbound/message-action-runner.js";
import { withServer } from "../src/plugin-sdk/test-helpers/http-test-server.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../src/plugins/runtime.js";
import { createTestRegistry } from "../src/test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";
import { createDeferred, withTestTimeout } from "./helpers/promise.js";

const AUTH_PATH = "/open-apis/auth/v3/tenant_access_token/internal";
const TARGET = "oc_mutation";
const MESSAGE_ID = "om_mutation";
const MESSAGE_PATH = `/open-apis/im/v1/messages/${MESSAGE_ID}`;
const PIN_PATH = "/open-apis/im/v1/pins";
const REACTION_PATH = `${MESSAGE_PATH}/reactions`;

type WireRequest = { method: string; path: string; query: string; body: string };
type ResponseHandler = (request: WireRequest, response: ServerResponse) => Promise<unknown>;

const routes = [
  {
    name: "text edit",
    params: { action: "edit" },
    requests: [`PUT ${MESSAGE_PATH}`],
    result: { ok: true, action: "edit", messageId: MESSAGE_ID, contentType: "post" },
  },
  {
    name: "card edit",
    params: {
      action: "edit",
      message: undefined,
      card: { elements: [{ tag: "markdown", content: "Updated card" }] },
    },
    requests: [`PATCH ${MESSAGE_PATH}`],
    result: { ok: true, action: "edit", messageId: MESSAGE_ID, contentType: "interactive" },
  },
  {
    name: "pin",
    params: { action: "pin" },
    requests: [`POST ${PIN_PATH}`],
    result: { ok: true, action: "pin", pin: { messageId: MESSAGE_ID } },
  },
  {
    name: "unpin",
    params: { action: "unpin" },
    requests: [`DELETE ${PIN_PATH}/${MESSAGE_ID}`],
    result: { ok: true, action: "unpin", messageId: MESSAGE_ID },
  },
  {
    name: "reaction addition",
    params: { action: "react", emoji: "SMILE" },
    requests: [`POST ${REACTION_PATH}`],
    result: { ok: true, added: "SMILE" },
  },
  {
    name: "reaction removal",
    params: { action: "react", emoji: "SMILE", remove: true },
    requests: [`GET ${REACTION_PATH}`, `DELETE ${REACTION_PATH}/reaction_own`],
    result: { ok: true, removed: "SMILE" },
  },
  {
    name: "clearing reactions",
    params: { action: "react", clearAll: true },
    requests: [`GET ${REACTION_PATH}`, `DELETE ${REACTION_PATH}/reaction_own`],
    result: { ok: true, removed: 1 },
  },
];

async function withFeishuMutation(
  run: (fixture: {
    cfg: OpenClawConfig;
    requests: WireRequest[];
    execute: (params?: Record<string, unknown>) => Promise<unknown>;
    retire: () => void;
    gate: () => ReturnType<typeof createDeferred<void>>;
    respond: (handler: ResponseHandler) => void;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ label: "feishu-mutation" }, async (state) => {
    const requests: WireRequest[] = [];
    const pending: Promise<unknown>[] = [];
    const releases: Array<() => void> = [];
    const appId = `cli_mutation_${randomUUID()}`;
    let handleRequest: ResponseHandler = async () => undefined;
    await withServer(
      (request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const record = {
            method: request.method ?? "",
            path: new URL(request.url ?? "/", "http://127.0.0.1").pathname,
            query: new URL(request.url ?? "/", "http://127.0.0.1").search,
            body: Buffer.concat(chunks).toString("utf8"),
          };
          requests.push(record);
          const override = await handleRequest(record, response);
          if (response.writableEnded) {
            return;
          }
          const body =
            override ??
            (record.path === AUTH_PATH
              ? { code: 0, tenant_access_token: "loopback-token", expire: 7200 }
              : record.method === "GET" && record.path === MESSAGE_PATH
                ? {
                    code: 0,
                    data: {
                      items: [
                        {
                          message_id: MESSAGE_ID,
                          chat_id: TARGET,
                          chat_type: "group",
                          msg_type: "text",
                          body: { content: JSON.stringify({ text: "Original message" }) },
                        },
                      ],
                    },
                  }
                : record.method === "GET" && record.path === REACTION_PATH
                  ? {
                      code: 0,
                      data: {
                        items: [
                          {
                            reaction_id: "reaction_foreign",
                            operator: { operator_type: "app", operator_id: "another_app" },
                          },
                          {
                            reaction_id: "reaction_user",
                            operator: { operator_type: "user", operator_id: "ou_requester" },
                          },
                          {
                            reaction_id: "reaction_own",
                            reaction_type: { emoji_type: "SMILE" },
                            operator: { operator_type: "app", operator_id: appId },
                          },
                        ],
                      },
                    }
                  : {
                      code: 0,
                      data: {
                        message_id: MESSAGE_ID,
                        reaction_id: "reaction_own",
                        pin: { message_id: MESSAGE_ID, chat_id: TARGET },
                      },
                    });
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(body));
        })().catch((error: unknown) => response.writeHead(500).end(String(error)));
      },
      async (origin) => {
        const cfg: OpenClawConfig = {
          channels: {
            feishu: {
              enabled: true,
              appId,
              appSecret: "loopback-placeholder", // pragma: allowlist secret
              domain: origin,
              groupPolicy: "open",
              actions: { reactions: true },
            },
          },
        };
        setRuntimeConfigSnapshot(cfg, cfg);
        setActivePluginRegistry(
          createTestRegistry([
            { pluginId: "feishu", source: "test", origin: "bundled", plugin: feishuPlugin },
          ]),
        );
        const identity = {
          agentId: "main",
          runId: randomUUID(),
          sessionKey: `agent:main:feishu:group:${TARGET}`,
        };
        const token = mintMessageActionTurnCapability({
          ...identity,
          requesterAccountId: "default",
          requesterSenderId: "ou_requester",
          toolContext: {
            currentChannelProvider: "feishu",
            currentChannelId: TARGET,
            currentChatType: "group",
          },
        });
        const tool = createMessageTool({
          config: cfg,
          agentId: identity.agentId,
          runId: identity.runId,
          agentSessionKey: identity.sessionKey,
          workspaceDir: state.workspaceDir,
          messageActionTurnCapability: token,
          getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
          resolveCommandSecretRefsViaGateway: async ({ config }) => ({
            resolvedConfig: config,
            diagnostics: [],
            targetStatesByPath: {},
            hadUnresolvedTargets: false,
          }),
          runMessageAction,
        });
        try {
          await run({
            cfg,
            requests,
            execute: (params = {}) => {
              const result = tool.execute(randomUUID(), {
                action: "edit",
                channel: "feishu",
                target: `chat:${TARGET}`,
                messageId: MESSAGE_ID,
                message: "Updated message",
                ...params,
              });
              pending.push(result);
              return result;
            },
            retire: () => revokeMessageActionTurnCapability(token),
            gate: () => {
              const gate = createDeferred();
              releases.push(() => gate.resolve());
              return gate;
            },
            respond: (handler) => {
              handleRequest = handler;
            },
          });
        } finally {
          for (const release of releases) {
            release();
          }
          await Promise.allSettled(pending);
          revokeMessageActionTurnCapability(token);
        }
      },
    );
  });
}

afterEach(() => {
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
});

describe("Feishu mutations through the message tool and Lark HTTP transport", () => {
  it.each(routes)("performs $name normally for a current caller", async (route) => {
    await withFeishuMutation(async ({ execute, requests }) => {
      await expect(execute(route.params)).resolves.toMatchObject({ details: route.result });
      expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
        `POST ${AUTH_PATH}`,
        `GET ${MESSAGE_PATH}`,
        ...route.requests,
      ]);
    });
  });

  it.each(routes)(
    "stops $name after retirement during renewed token preparation",
    async (route) => {
      await withFeishuMutation(async ({ execute, requests, respond, retire, gate }) => {
        const started = gate();
        const release = gate();
        let tokens = 0;
        respond(async ({ path }) => {
          if (path === AUTH_PATH) {
            tokens += 1;
            if (tokens === 1) {
              // The real SDK refreshes before the action's next request.
              return { code: 0, tenant_access_token: "short-lived-fixture-token", expire: 1 };
            }
            started.resolve();
            await release.promise;
          }
          return undefined;
        });
        const result = execute(route.params).catch((error: unknown) => error);
        await withTestTimeout(started.promise, 5_000, "Feishu token request");
        retire();
        release.resolve();
        expect(await result).toBeInstanceOf(Error);
        expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
          `POST ${AUTH_PATH}`,
          `GET ${MESSAGE_PATH}`,
          `POST ${AUTH_PATH}`,
        ]);
      });
    },
  );

  it.each([AUTH_PATH, MESSAGE_PATH])(
    "stops after retirement while authorizing through %s",
    async (waitAt) => {
      await withFeishuMutation(async ({ execute, requests, respond, retire, gate }) => {
        const started = gate();
        const release = gate();
        respond(async ({ path }) => {
          if (path === waitAt) {
            started.resolve();
            await release.promise;
          }
        });
        const result = execute().catch((error: unknown) => error);
        await withTestTimeout(started.promise, 5_000, "Feishu authorization request");
        retire();
        release.resolve();
        expect(await result).toMatchObject({
          message: "message action turn capability is no longer active",
        });
        expect(requests.map(({ path }) => path)).toEqual(
          waitAt === AUTH_PATH ? [AUTH_PATH] : [AUTH_PATH, MESSAGE_PATH],
        );
      });
    },
  );

  it("checks currentness between reaction pages and preserves the active caller's own reactions", async () => {
    for (const retired of [false, true]) {
      await withFeishuMutation(async ({ cfg, execute, requests, respond, retire }) => {
        respond(async ({ method, path, query }) => {
          if (method !== "GET" || path !== REACTION_PATH) {
            return undefined;
          }
          const secondPage = new URLSearchParams(query).has("page_token");
          if (!secondPage && retired) {
            retire();
          }
          return {
            code: 0,
            data: {
              items: [
                {
                  reaction_id: secondPage ? "reaction_own" : "reaction_foreign",
                  operator: {
                    operator_type: "app",
                    operator_id: secondPage ? cfg.channels!.feishu!.appId : "another_app",
                  },
                },
              ],
              has_more: !secondPage,
              page_token: secondPage ? undefined : "next_page",
            },
          };
        });
        const result = execute({ action: "react", clearAll: true });
        if (retired) {
          await expect(result).rejects.toThrow();
        } else {
          await expect(result).resolves.toMatchObject({ details: { ok: true, removed: 1 } });
        }
        expect(requests.filter(({ path }) => path === REACTION_PATH)).toHaveLength(retired ? 1 : 2);
        expect(
          requests.filter(({ method }) => method === "DELETE").map(({ path }) => path),
        ).toEqual(retired ? [] : [`${REACTION_PATH}/reaction_own`]);
      });
    }
  });

  it("stops clearing reactions after one accepted deletion when its caller retires", async () => {
    await withFeishuMutation(async ({ cfg, execute, requests, respond, retire }) => {
      respond(async ({ method, path }) => {
        if (method === "GET" && path === REACTION_PATH) {
          return {
            code: 0,
            data: {
              items: ["first", "second"].map((reaction_id) => ({
                reaction_id,
                operator: { operator_type: "app", operator_id: cfg.channels!.feishu!.appId },
              })),
            },
          };
        }
        if (method === "DELETE") {
          retire();
        }
        return undefined;
      });
      await expect(execute({ action: "react", clearAll: true })).rejects.toThrow();
      expect(requests.filter(({ method }) => method === "DELETE").map(({ path }) => path)).toEqual([
        `${REACTION_PATH}/first`,
      ]);
    });
  });

  it("settles an accepted edit in the adapter while core rejects its closed caller", async () => {
    await withFeishuMutation(async ({ execute, requests, respond, retire }) => {
      const handler = vi.spyOn(feishuPlugin.actions!, "handleAction");
      respond(async ({ method }) => {
        if (method === "PUT") {
          retire();
        }
      });
      await expect(execute()).rejects.toThrow("message action turn capability is no longer active");
      await expect(handler.mock.results[0]?.value).resolves.toMatchObject({
        details: { ok: true, messageId: MESSAGE_ID, contentType: "post" },
      });
      expect(requests.filter(({ method }) => method === "PUT")).toHaveLength(1);
    });
  });

  it("preserves dispatch uncertainty when retirement blocks a mutation redirect", async () => {
    await withFeishuMutation(async ({ execute, requests, respond, retire }) => {
      respond(async ({ method, path }, response) => {
        if (method === "PUT" && path === MESSAGE_PATH) {
          retire();
          response.writeHead(307, { location: `${MESSAGE_PATH}/redirected` }).end();
        }
      });
      const error = await execute().catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(PlatformMessageNotDispatchedError);
      expect(requests.filter(({ method }) => method === "PUT").map(({ path }) => path)).toEqual([
        MESSAGE_PATH,
      ]);
    });
  });

  it("preserves a provider failure after an earlier reaction was removed", async () => {
    await withFeishuMutation(async ({ cfg, execute, requests, respond }) => {
      respond(async ({ method, path }) => {
        if (method === "GET" && path === REACTION_PATH) {
          return {
            code: 0,
            data: {
              items: ["first", "second"].map((reaction_id) => ({
                reaction_id,
                operator: { operator_type: "app", operator_id: cfg.channels!.feishu!.appId },
              })),
            },
          };
        }
        if (path === `${REACTION_PATH}/second`) {
          return { code: 123, msg: "Fixture rejected second removal" };
        }
        return undefined;
      });
      await expect(execute({ action: "react", clearAll: true })).rejects.toThrow(
        "Fixture rejected second removal",
      );
      expect(requests.filter(({ method }) => method === "DELETE").map(({ path }) => path)).toEqual([
        `${REACTION_PATH}/first`,
        `${REACTION_PATH}/second`,
      ]);
    });
  });

  it.each(routes.filter(({ name }) => ["text edit", "pin", "reaction addition"].includes(name)))(
    "keeps provider errors with incidental IDs as failures for $name",
    async (route) => {
      await withFeishuMutation(async ({ execute, respond }) => {
        respond(async ({ method, path }) => {
          if (`${method} ${path}` === route.requests.at(-1)) {
            return {
              code: 123,
              msg: "Fixture rejected mutation",
              data: { message_id: MESSAGE_ID, reaction_id: "incidental" },
            };
          }
          return undefined;
        });
        await expect(execute(route.params)).rejects.toThrow("Fixture rejected mutation");
      });
    },
  );

  it("retains the configured group policy denial", async () => {
    await withFeishuMutation(async ({ cfg, execute, requests }) => {
      cfg.channels!.feishu!.groupPolicy = "disabled";
      await expect(execute()).rejects.toThrow(/not allowed/);
      expect(requests).toEqual([]);
    });
  });
});
