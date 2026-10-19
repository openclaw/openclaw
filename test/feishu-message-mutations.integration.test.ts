import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
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
import {
  commandSecretFixture,
  readRequestText,
  respondJson,
} from "./helpers/gateway-integration-fixtures.js";
import { createDeferred, withTestTimeout } from "./helpers/promise.js";

const AUTH_PATH = "/open-apis/auth/v3/tenant_access_token/internal";
const TARGET = "oc_mutation";
const MESSAGE_ID = "om_mutation";
const MESSAGE_PATH = `/open-apis/im/v1/messages/${MESSAGE_ID}`;
const PIN_PATH = "/open-apis/im/v1/pins";
const REACTION_PATH = `${MESSAGE_PATH}/reactions`;

type WireRequest = { method: string; path: string; query: string };
type ResponseHandler = (request: WireRequest, response: ServerResponse) => Promise<unknown>;

const success = (data: unknown) => ({ code: 0, data });
const items = (...rows: unknown[]) => success({ items: rows });
const reaction = (reaction_id: string, operator_type: string, operator_id: string) => ({
  reaction_id,
  operator: { operator_type, operator_id },
});

function defaultResponse({ method, path }: WireRequest, appId: string) {
  if (path === AUTH_PATH) {
    return { code: 0, tenant_access_token: "loopback-token", expire: 7200 };
  }
  if (method === "GET" && path === MESSAGE_PATH) {
    return items({
      message_id: MESSAGE_ID,
      chat_id: TARGET,
      chat_type: "group",
      msg_type: "text",
      body: { content: JSON.stringify({ text: "Original message" }) },
    });
  }
  if (method === "GET" && path === REACTION_PATH) {
    return items(
      reaction("reaction_foreign", "app", "another_app"),
      reaction("reaction_user", "user", "ou_requester"),
      { ...reaction("reaction_own", "app", appId), reaction_type: { emoji_type: "SMILE" } },
    );
  }
  return success({
    message_id: MESSAGE_ID,
    reaction_id: "reaction_own",
    pin: { message_id: MESSAGE_ID, chat_id: TARGET },
  });
}

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

const mutationScopes = routes.filter(({ name }) =>
  ["text edit", "pin", "reaction addition"].includes(name),
);

async function withFeishuMutation(
  run: (fixture: {
    cfg: OpenClawConfig;
    requests: WireRequest[];
    paths: (method?: string) => string[];
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
          await readRequestText(request);
          const url = new URL(request.url ?? "/", "http://127.0.0.1");
          const record = {
            method: request.method ?? "",
            path: url.pathname,
            query: url.search,
          };
          requests.push(record);
          const override = await handleRequest(record, response);
          if (response.writableEnded) {
            return;
          }
          respondJson(response, override ?? defaultResponse(record, appId));
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
          ...commandSecretFixture,
          runMessageAction,
        });
        try {
          await run({
            cfg,
            requests,
            paths: (method) =>
              requests
                .filter((request) => !method || request.method === method)
                .map(({ method: verb, path }) => (method ? path : `${verb} ${path}`)),
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

it.each(routes)("performs $name normally for a current caller", (route) =>
  withFeishuMutation(async ({ execute, paths }) => {
    await expect(execute(route.params)).resolves.toMatchObject({ details: route.result });
    expect(paths()).toEqual([`POST ${AUTH_PATH}`, `GET ${MESSAGE_PATH}`, ...route.requests]);
  }),
);

it.each([
  ...mutationScopes.map((route) => ({
    ...route,
    name: `${route.name} renewed token`,
    waitAt: AUTH_PATH,
    renewed: true,
  })),
  ...[AUTH_PATH, MESSAGE_PATH].map((waitAt) => ({
    name: `authorization through ${waitAt}`,
    params: {},
    waitAt,
    renewed: false,
  })),
])("stops after retirement during $name", ({ params, waitAt, renewed }) =>
  withFeishuMutation(async ({ execute, paths, respond, retire, gate }) => {
    const started = gate();
    const release = gate();
    let tokens = 0;
    respond(async ({ path }) => {
      if (path === waitAt) {
        if (renewed && ++tokens === 1) {
          // The real SDK refreshes before the action's next request.
          return { code: 0, tenant_access_token: "short-lived-fixture-token", expire: 1 };
        }
        started.resolve();
        await release.promise;
      }
      return undefined;
    });
    const result = execute(params).catch((error: unknown) => error);
    await withTestTimeout(started.promise, 5_000, "Feishu authorization request");
    retire();
    release.resolve();
    if (renewed) {
      expect(await result).toBeInstanceOf(Error);
    } else {
      expect(await result).toMatchObject({
        message: "message action turn capability is no longer active",
      });
    }
    expect(paths()).toEqual([
      `POST ${AUTH_PATH}`,
      ...(renewed || waitAt === MESSAGE_PATH ? [`GET ${MESSAGE_PATH}`] : []),
      ...(renewed ? [`POST ${AUTH_PATH}`] : []),
    ]);
  }),
);

it.each([false, true])("checks reaction-page currentness (retired: %s)", (retired) =>
  withFeishuMutation(async ({ cfg, execute, requests, paths, respond, retire }) => {
    respond(async ({ method, path, query }) => {
      if (method !== "GET" || path !== REACTION_PATH) {
        return undefined;
      }
      const secondPage = new URLSearchParams(query).has("page_token");
      if (!secondPage && retired) {
        retire();
      }
      return success({
        items: [
          reaction(
            secondPage ? "reaction_own" : "reaction_foreign",
            "app",
            secondPage ? cfg.channels!.feishu!.appId : "another_app",
          ),
        ],
        has_more: !secondPage,
        page_token: secondPage ? undefined : "next_page",
      });
    });
    const result = execute({ action: "react", clearAll: true });
    if (retired) {
      await expect(result).rejects.toThrow();
    } else {
      await expect(result).resolves.toMatchObject({ details: { ok: true, removed: 1 } });
    }
    expect(requests.filter(({ path }) => path === REACTION_PATH)).toHaveLength(retired ? 1 : 2);
    expect(paths("DELETE")).toEqual(retired ? [] : [`${REACTION_PATH}/reaction_own`]);
  }),
);

it.each(["retirement", "provider failure"])(
  "preserves %s after an accepted reaction deletion",
  (failure) =>
    withFeishuMutation(async ({ cfg, execute, paths, respond, retire }) => {
      respond(async ({ method, path }) => {
        if (method === "GET" && path === REACTION_PATH) {
          return items(
            ...["first", "second"].map((id) => reaction(id, "app", cfg.channels!.feishu!.appId)),
          );
        }
        if (method === "DELETE" && failure === "retirement") {
          retire();
        }
        if (failure === "provider failure" && path === `${REACTION_PATH}/second`) {
          return { code: 123, msg: "Fixture rejected second removal" };
        }
        return undefined;
      });
      const result = execute({ action: "react", clearAll: true });
      if (failure === "retirement") {
        await expect(result).rejects.toThrow();
      } else {
        await expect(result).rejects.toThrow("Fixture rejected second removal");
      }
      expect(paths("DELETE")).toEqual([
        `${REACTION_PATH}/first`,
        ...(failure === "provider failure" ? [`${REACTION_PATH}/second`] : []),
      ]);
    }),
);

it.each(["accepted", "redirected"])(
  "preserves %s edit settlement after caller retirement",
  (outcome) =>
    withFeishuMutation(async ({ execute, paths, respond, retire }) => {
      const handler = vi.spyOn(feishuPlugin.actions!, "handleAction");
      respond(async ({ method, path }, response) => {
        if (method === "PUT" && path === MESSAGE_PATH) {
          retire();
          if (outcome === "redirected") {
            response.writeHead(307, { location: `${MESSAGE_PATH}/redirected` }).end();
          }
        }
      });
      const result = execute();
      if (outcome === "accepted") {
        await expect(result).rejects.toThrow("message action turn capability is no longer active");
        await expect(handler.mock.results[0]?.value).resolves.toMatchObject({
          details: { ok: true, messageId: MESSAGE_ID, contentType: "post" },
        });
      } else {
        const error = await result.catch((cause: unknown) => cause);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(PlatformMessageNotDispatchedError);
      }
      expect(paths("PUT")).toEqual([MESSAGE_PATH]);
    }),
);

it.each(mutationScopes)(
  "keeps provider errors with incidental IDs as failures for $name",
  (route) =>
    withFeishuMutation(async ({ execute, respond }) => {
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
    }),
);

it("retains the configured group policy denial", () =>
  withFeishuMutation(async ({ cfg, execute, requests }) => {
    cfg.channels!.feishu!.groupPolicy = "disabled";
    await expect(execute()).rejects.toThrow(/not allowed/);
    expect(requests).toEqual([]);
  }));
