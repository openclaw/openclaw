import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { expect, it, vi } from "vitest";
import * as codexAuth from "../../extensions/codex/src/app-server/auth-profile.js";
import { CodexAppServerClient } from "../../extensions/codex/src/app-server/client.js";
import { setManagedCodexPluginRoot } from "../../extensions/codex/src/app-server/managed-binary.js";
import { createCodexNativeTestState } from "../../extensions/codex/src/app-server/native-app-server.test-support.js";
import { isJsonObject, type JsonObject } from "../../extensions/codex/src/app-server/protocol.js";
import * as shared from "../../extensions/codex/src/app-server/shared-client.js";
import { CODEX_APP_SERVER_VERSION } from "../../extensions/codex/src/app-server/version.js";
import { createCodexWebSearchProvider } from "../../extensions/codex/src/web-search-provider.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { addSessionMember, removeSessionMember } from "../config/sessions/session-sharing-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { withToolsInvokeTestState } from "./tools-invoke-http.test-support.js";
import { invokeGatewayTool } from "./tools-invoke-shared.js";

vi.unmock("node:child_process");

const MODEL = "gpt-5.4";
const DEFAULT_MODEL = "gpt-5.5";
const PROFILE = "openai:selected-native-search";
const DEFAULT_PROFILE = "openai:default-native-search";
const KEY = "synthetic-selected-search-account";
const DEFAULT_KEY = "synthetic-default-search-account";
const QUERY = "synthetic native selected-profile search";
const CALL = "native-search-call";
const SOURCE_URL = "https://example.com/native-search-source";
const TITLE = "Native search source";

function event(type: string, fields: JsonObject) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
}
function completed(id: string) {
  return event("response.completed", {
    response: { id, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } },
  });
}
function model(slug: string, priority: number) {
  return {
    slug,
    display_name: `Synthetic ${slug}`,
    supported_reasoning_levels: [],
    shell_type: "local",
    visibility: "list",
    supported_in_api: true,
    priority,
    support_verbosity: false,
    truncation_policy: { mode: "bytes", limit: 10000 },
    experimental_supported_tools: [],
    context_window: 200000,
    input_modalities: ["text"],
    model_messages: {
      instructions_template: "You are a test assistant.",
      collaboration_modes: { default: "Synthetic model-owned policy." },
    },
  };
}

it.skipIf(process.platform === "win32")(
  "pins native web_search and rechecks persisted membership before native startup",
  { timeout: 90_000 },
  async () => {
    await withToolsInvokeTestState(
      { label: "native-search-authority", prepareProfileCatalog: true },
      async (state) => {
        const native = await createCodexNativeTestState(state.path("native"));
        const catalog = state.path("native-models.json");
        await fs.writeFile(
          catalog,
          JSON.stringify({ models: [model(DEFAULT_MODEL, 1), model(MODEL, 2)] }),
        );
        const requests: Array<{
          method: string;
          path: string;
          account: string | undefined;
          body?: JsonObject;
        }> = [];
        const upstreamErrors: unknown[] = [];
        const clients = new Set<CodexAppServerClient>();
        let responses = 0;
        let waitBeforeAcquire: (() => Promise<void>) | undefined;
        let upstream:
          | Awaited<ReturnType<typeof reserveTestPortListener<ReturnType<typeof createServer>>>>
          | undefined;
        try {
          for (const [name, value] of Object.entries(native.env)) {
            vi.stubEnv(name, value);
          }
          vi.stubEnv("OPENAI_API_KEY", undefined);
          vi.stubEnv("CODEX_API_KEY", undefined);
          vi.stubEnv("OPENCLAW_CODEX_APP_SERVER_BIN", undefined);
          setManagedCodexPluginRoot(path.resolve("extensions/codex"));

          async function respond(req: IncomingMessage, res: ServerResponse) {
            const requestPath = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
            const bytes = await buffer(req);
            const parsed: unknown = bytes.length ? JSON.parse(bytes.toString("utf8")) : undefined;
            const body = isJsonObject(parsed) ? parsed : undefined;
            requests.push({
              method: req.method ?? "",
              path: requestPath,
              account: req.headers.authorization,
              ...(body ? { body } : {}),
            });
            // The real native client falls back to HTTP for this SSE fixture.
            if (req.method === "GET" && requestPath === "/v1/responses") {
              res.writeHead(426).end();
              return;
            }
            expect(req.method).toBe("POST");
            expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
            expect(body?.model).toBe(MODEL);
            if (requestPath === "/v1/alpha/search") {
              expect(body?.commands).toEqual({ search_query: [{ q: QUERY }] });
              res.writeHead(200, { "content-type": "application/json" }).end(
                JSON.stringify({
                  encrypted_output: "synthetic-ciphertext",
                  output: "Synthetic search result",
                  results: [
                    {
                      type: "text_result",
                      ref_id: "turn0search0",
                      url: SOURCE_URL,
                      title: TITLE,
                      snippet: "Synthetic source metadata.",
                    },
                  ],
                }),
              );
              return;
            }
            expect(requestPath).toBe("/v1/responses");
            responses += 1;
            let output: string;
            if (responses === 1) {
              const tools = Array.isArray(body?.tools) ? body.tools : [];
              expect(
                tools.some(
                  (tool) =>
                    isJsonObject(tool) &&
                    tool.type === "namespace" &&
                    tool.name === "web" &&
                    Array.isArray(tool.tools) &&
                    tool.tools.some((child) => isJsonObject(child) && child.name === "run"),
                ),
              ).toBe(true);
              output =
                event("response.created", { response: { id: "search-response" } }) +
                event("response.output_item.done", {
                  item: {
                    type: "function_call",
                    call_id: CALL,
                    namespace: "web",
                    name: "run",
                    arguments: JSON.stringify({ search_query: [{ q: QUERY }] }),
                  },
                }) +
                completed("search-response");
            } else {
              expect(responses).toBe(2);
              expect(body?.input).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({ type: "function_call_output", call_id: CALL }),
                ]),
              );
              output =
                event("response.created", { response: { id: "answer-response" } }) +
                event("response.output_item.done", {
                  item: {
                    type: "message",
                    role: "assistant",
                    id: "native-search-answer",
                    content: [{ type: "output_text", text: `The source is ${SOURCE_URL}.` }],
                  },
                }) +
                completed("answer-response");
            }
            res.writeHead(200, { "content-type": "text/event-stream" }).end(output);
          }
          upstream = await reserveTestPortListener({
            offsets: [0],
            createListener: () =>
              createServer((req, res) => {
                void respond(req, res).catch((error: unknown) => {
                  upstreamErrors.push(error);
                  if (!res.headersSent) {
                    res.writeHead(500);
                  }
                  res.end();
                });
              }),
          });
          const cfg: OpenClawConfig = {
            agents: {
              defaults: {
                model: `openai/${DEFAULT_MODEL}@${DEFAULT_PROFILE}`,
                sandbox: { mode: "off" },
              },
              entries: { main: { agentDir: state.agentDir(), workspace: state.workspaceDir } },
            },
            auth: { order: { openai: [DEFAULT_PROFILE, PROFILE] } },
            gateway: {
              roles: {
                default: "guest",
                definitions: {
                  guest: {
                    sessions: { others: "view" },
                    agents: ["main"],
                    scopes: ["operator.write"],
                  },
                },
              },
              tools: { allow: ["web_search"] },
            },
            tools: {
              allow: ["web_search"],
              web: {
                search: {
                  provider: "codex",
                  timeoutSeconds: 45,
                  openaiCodex: { enabled: true, mode: "live" },
                },
              },
            },
            plugins: {
              allow: ["codex"],
              slots: { memory: "none" },
              entries: {
                codex: {
                  enabled: true,
                  config: {
                    appServer: {
                      command: native.command,
                      transport: "stdio",
                      homeScope: "agent",
                      args: [
                        "app-server",
                        "-c",
                        `openai_base_url=${JSON.stringify(`http://127.0.0.1:${upstream.claim.port}/v1`)}`,
                        "-c",
                        `model_catalog_json=${JSON.stringify(catalog)}`,
                      ],
                      clearEnv: Object.keys(process.env).filter((name) => !(name in native.env)),
                    },
                  },
                },
              },
            },
          };
          await state.writeConfig(cfg);
          setRuntimeConfigSnapshot(cfg);
          await state.writeAuthProfiles({
            version: 1,
            profiles: {
              [DEFAULT_PROFILE]: { type: "api_key", provider: "openai", key: DEFAULT_KEY },
              [PROFILE]: { type: "api_key", provider: "openai", key: KEY },
            },
          });
          const owner = ensureProfileForEmail("native-owner@example.test");
          const member = ensureProfileForEmail("native-member@example.test");
          const outsider = ensureProfileForEmail("native-outsider@example.test");
          using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
          const scope = { agentId: "main", sessionKey: "agent:main:native-search-authority" };
          await upsertSessionEntryCore(scope, {
            sessionId: "native-search-authority",
            updatedAt: 1,
            visibility: "read-only",
            createdActor: { type: "human", source: "profile", id: owner.id },
            providerOverride: "openai",
            modelOverride: MODEL,
            authProfileOverride: PROFILE,
          });
          await addSessionMember(scope, { identityId: member.id, addedBy: owner.id });
          // Register the actual extension provider at its production seam.
          const registry = createEmptyPluginRegistry();
          registry.webSearchProviders.push({
            pluginId: "codex",
            source: "test",
            provider: createCodexWebSearchProvider(),
          });
          const invoke = (profile: typeof member, query: string) =>
            withPluginRuntimeGatewayRequestScope(
              { pluginRegistry: registry, isWebchatConnect: () => false },
              () =>
                invokeGatewayTool({
                  cfg,
                  input: { name: "web_search", sessionKey: scope.sessionKey, args: { query } },
                  authenticatedUserProfile: {
                    profileId: profile.id,
                    displayName: profile.displayName,
                    avatarRevision: "synthetic-avatar",
                    hasAvatar: false,
                    updatedAt: profile.updatedAt,
                  },
                  operatorRoleActor: { kind: "operator", profileId: profile.id },
                  operatorScopes: ["operator.write"],
                  toolCallIdPrefix: "native-search-proof",
                }),
            );
          const originalAcquire = shared.createIsolatedCodexAppServerClient;
          using acquire = vi
            .spyOn(shared, "createIsolatedCodexAppServerClient")
            .mockImplementation(async (options) => {
              await waitBeforeAcquire?.();
              return originalAcquire({
                ...options,
                onStartedClient(client) {
                  clients.add(client);
                  options?.onStartedClient?.(client);
                },
              });
            });
          using authReads = vi.spyOn(codexAuth, "resolveCodexAppServerAuthProfileStore");
          using nativeStarts = vi.spyOn(CodexAppServerClient, "start");
          expect(await invoke(member, QUERY)).toMatchObject({
            ok: true,
            status: 200,
            result: {
              details: {
                kind: "answer",
                provider: "codex",
                query: QUERY,
                citations: [{ url: SOURCE_URL, title: expect.stringContaining(TITLE) }],
              },
            },
          });
          expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ authProfileId: PROFILE }));
          expect(
            requests
              .filter((r) => r.method === "POST")
              .map((r) => ({ path: r.path, account: r.account, model: r.body?.model })),
          ).toEqual([
            { path: "/v1/responses", account: `Bearer ${KEY}`, model: MODEL },
            { path: "/v1/alpha/search", account: `Bearer ${KEY}`, model: MODEL },
            { path: "/v1/responses", account: `Bearer ${KEY}`, model: MODEL },
          ]);
          expect(clients.size).toBeGreaterThan(0);
          for (const client of clients) {
            expect(client.getServerVersion()).toBe(CODEX_APP_SERVER_VERSION);
          }
          const reset = () => {
            requests.length = 0;
            acquire.mockClear();
            authReads.mockClear();
            nativeStarts.mockClear();
          };
          const expectNoEffect = () => {
            expect(authReads).not.toHaveBeenCalled();
            expect(nativeStarts).not.toHaveBeenCalled();
            expect(requests).toEqual([]);
          };
          reset();
          expect(await invoke(outsider, `${QUERY} forbidden`)).toMatchObject({
            ok: false,
            status: 403,
            error: { message: expect.stringContaining("read-only") },
          });
          expect(acquire).not.toHaveBeenCalled();
          expectNoEffect();
          reset();
          const entered = Promise.withResolvers<void>();
          const release = Promise.withResolvers<void>();
          waitBeforeAcquire = async () => {
            entered.resolve();
            await release.promise;
          };
          const pending = invoke(member, `${QUERY} revoked`);
          try {
            await Promise.race([
              entered.promise,
              pending.then(() => {
                throw new Error("Invocation settled before native acquisition");
              }),
            ]);
            await removeSessionMember(scope, member.id);
          } finally {
            release.resolve();
          }
          expect(await pending).toMatchObject({
            ok: false,
            status: 403,
            error: { message: expect.stringContaining("read-only") },
          });
          waitBeforeAcquire = undefined;
          expect(acquire).toHaveBeenCalledOnce();
          expectNoEffect();
          expect(upstreamErrors).toEqual([]);
        } finally {
          try {
            for (const client of clients) {
              await client.closeAndWait();
            }
            if (upstream) {
              upstream.listener.closeAllConnections();
              await upstream.releaseListener();
              await upstream.claim.release();
            }
          } finally {
            vi.unstubAllEnvs();
            setManagedCodexPluginRoot(undefined);
          }
        }
      },
    );
  },
);
