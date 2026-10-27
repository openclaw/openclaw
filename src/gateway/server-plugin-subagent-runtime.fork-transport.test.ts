import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { writeOpenAiResponsesSse } from "../../test/helpers/openai-responses-sse.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import "../agents/ai-transport-runtime-host.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import { closeProviderTransportDispatcherPool } from "../agents/provider-transport-dispatcher-pool.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { addSessionMember, removeSessionMember } from "../config/sessions/session-sharing-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as ssrf from "../infra/net/ssrf.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { resetCommandQueueStateForTest } from "../process/command-queue.test-support.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import {
  disposeSessionReadContexts,
  identifiedClient,
  initializeSessionReadContext,
  requestContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import { createGatewaySubagentRuntime } from "./server-plugin-subagent-runtime.js";

const PLUGIN_ID = "test-session-fork-transport";
const SESSION_ID = "fork-transport-parent";
const SESSION_KEY = "agent:research:telegram:direct:fork-transport-parent";
const API_KEY = "synthetic-fork-transport-key";

type RecordedRequest = {
  url: string | undefined;
  authorization: string | undefined;
  body: unknown;
};

it("allows invited session forks and rechecks revocation before provider HTTP", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const providerDir = state.path("provider");
    fs.mkdirSync(providerDir);
    const fixture = createColdPluginFixture({
      rootDir: providerDir,
      pluginId: "isolated-fork-fixture",
      providerId: "isolated-fork-provider",
    });
    fs.writeFileSync(
      fixture.runtimeSource,
      `module.exports = { id: ${JSON.stringify(fixture.pluginId)}, register(api) {
          api.registerProvider({
            id: ${JSON.stringify(fixture.providerId)}, label: "Isolated fork transport", auth: [],
          });
        } };`,
    );
    const requests: RecordedRequest[] = [];
    const { claim, listener, releaseListener } = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((request, response) => {
          const recorded: RecordedRequest = {
            url: request.url,
            authorization: request.headers.authorization,
            body: undefined,
          };
          requests.push(recorded);
          let body = "";
          request.setEncoding("utf8");
          request.on("data", (chunk: string) => {
            body += chunk;
          });
          request.on("end", () => {
            recorded.body = JSON.parse(body);
            writeOpenAiResponsesSse(response, [
              {
                id: "fork-transport-response",
                object: "chat.completion.chunk",
                model: "fork-model",
                choices: [{ index: 0, delta: { content: "fork-ok" }, finish_reason: "stop" }],
              },
            ]);
          });
        }),
    });
    const lifetime = new AbortController();
    try {
      await withEnvAsync(
        {
          ...createColdPluginHermeticEnv(state.root, {
            bundledPluginsDir: state.path("bundled-plugins"),
          }),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          HTTP_PROXY: undefined,
          HTTPS_PROXY: undefined,
          http_proxy: undefined,
          https_proxy: undefined,
          ALL_PROXY: undefined,
          all_proxy: undefined,
          NO_PROXY: "127.0.0.1,localhost,::1",
        },
        async () => {
          const baseUrl = `http://127.0.0.1:${claim.port}/v1`;
          const model = makeProviderModelFixture<"openai-completions">({
            provider: fixture.providerId,
            id: "fork-model",
            name: "Fork model",
            api: "openai-completions",
            baseUrl,
            contextWindow: 8192,
            maxTokens: 1024,
          });
          const config: OpenClawConfig = {
            channels: { telegram: { enabled: false, dmHistoryLimit: 1 } },
            agents: {
              defaults: {
                workspace: state.workspaceDir,
                userTimezone: "UTC",
                models: {
                  [`${fixture.providerId}/fork-model`]: { agentRuntime: { id: "openclaw" } },
                },
              },
              entries: { research: { model: `${fixture.providerId}/fork-model` } },
            },
            models: {
              providers: {
                [fixture.providerId]: {
                  api: "openai-completions",
                  apiKey: API_KEY,
                  baseUrl,
                  request: { allowPrivateNetwork: true },
                  models: [model],
                },
              },
            },
            plugins: {
              load: { paths: [fixture.rootDir] },
              slots: { memory: "none" },
              entries: {
                [fixture.pluginId]: { enabled: true },
                [PLUGIN_ID]: { hooks: { allowConversationAccess: true } },
              },
            },
            gateway: {
              roles: {
                default: "limited",
                definitions: {
                  limited: {
                    agents: ["research"],
                    scopes: ["operator.read", "operator.write"],
                    sessions: { others: "invited" },
                  },
                },
              },
            },
          };
          await state.writeConfig(config);
          setRuntimeConfigSnapshot(config);
          const owner = ensureProfileForEmail("fork-owner@example.test");
          const stranger = ensureProfileForEmail("fork-stranger@example.test");
          const member = ensureProfileForEmail("fork-member@example.test");
          await upsertSessionEntryCore(
            { agentId: "research", sessionKey: SESSION_KEY },
            {
              sessionId: SESSION_ID,
              updatedAt: 1,
              visibility: "shared",
              createdActor: { type: "human", source: "profile", id: owner.id },
            },
          );
          const context = requestContext(config);
          await initializeSessionReadContext(context);
          const runtime = createGatewaySubagentRuntime(() => context, {}, lifetime.signal);
          try {
            // A persisted conversation remains forkable without any process-local parent request.
            const transcript = await SessionManager.openAsync(
              {
                agentId: "research",
                sessionId: SESSION_ID,
                sessionKey: SESSION_KEY,
                storePath: path.join(state.agentDir("research"), "openclaw-agent.sqlite"),
              },
              state.workspaceDir,
            );
            const appendUser = (content: string, timestamp: number) =>
              transcript.appendMessageAsync({ role: "user", content, timestamp });
            await appendUser("DISCARDED_PRE_COMPACTION_1672", 0);
            const retainedId = await appendUser("Parent question", 1);
            if (!retainedId) {
              throw new Error("Retained question was not persisted");
            }
            const compactionId = await transcript.appendCompactionAsync(
              "Earlier request summarized for review",
              retainedId,
              100,
            );
            await appendUser("OUTSIDE_HISTORY_WINDOW_1672", 2);
            await appendUser("Parent question", 3);
            await transcript.appendCustomEntryAsync("openclaw.system-prompt", {
              prefix: "Stable parent instructions",
              renderedPrefix: "Stable parent instructions",
              routeKey: JSON.stringify([
                model.provider,
                model.id,
                model.api,
                model.baseUrl,
                true,
                null,
              ]),
              historyId: compactionId,
              tools: [],
            });

            const forkAs = (profileId: string) =>
              withPluginRuntimeGatewayRequestScope(
                {
                  pluginId: PLUGIN_ID,
                  client: identifiedClient(profileId),
                  isWebchatConnect: () => false,
                },
                () =>
                  runtime.forkSession({ sessionKey: SESSION_KEY, message: "Review the parent" }),
              );
            await expect(forkAs(stranger.id)).rejects.toThrow(
              `Session "${SESSION_KEY}" was not found`,
            );
            expect(requests).toHaveLength(0);

            await expect(forkAs(owner.id)).resolves.toMatchObject({ text: "fork-ok" });
            expect(requests).toHaveLength(1);
            expect(JSON.stringify(requests[0]?.body)).not.toContain(
              "DISCARDED_PRE_COMPACTION_1672",
            );
            expect(JSON.stringify(requests[0]?.body)).not.toContain("OUTSIDE_HISTORY_WINDOW_1672");
            expect(requests[0]?.body).not.toHaveProperty("prompt_cache_key");
            const user = (content: unknown) => ({ role: "user", content });
            expect(requests[0]).toMatchObject({
              url: "/v1/chat/completions",
              authorization: `Bearer ${API_KEY}`,
              body: {
                model: "fork-model",
                messages: [
                  { role: "system", content: "Stable parent instructions" },
                  user([
                    {
                      type: "text",
                      text: "The conversation history before this point was compacted into the following summary:\n\n<summary>\nEarlier request summarized for review\n</summary>",
                    },
                  ]),
                  user(expect.stringContaining("[Thu 1970-01-01 00:00 UTC] Parent question")),
                  user("Review the parent"),
                ],
              },
            });
            const scope = { agentId: "research", sessionKey: SESSION_KEY };
            await addSessionMember(scope, { identityId: member.id, addedBy: owner.id });
            await expect(forkAs(member.id)).resolves.toMatchObject({ text: "fork-ok" });
            expect(requests).toHaveLength(2);
            expect(requests[1]).toEqual(requests[0]);

            const entered = createDeferred();
            const release = createDeferred();
            const resolve = ssrf.resolvePinnedHostnameWithPolicy;
            let armed = true;
            using _ = vi
              .spyOn(ssrf, "resolvePinnedHostnameWithPolicy")
              .mockImplementation(async (...args) => {
                const result = await resolve(...args);
                if (armed && args[0] === "127.0.0.1") {
                  armed = false;
                  entered.resolve();
                  await release.promise;
                }
                return result;
              });
            const pending = forkAs(member.id);
            void pending.catch(() => {});
            try {
              await withinTest(
                awaitGateBeforeSettlement(
                  entered.promise,
                  pending,
                  "fork skipped provider address preparation",
                ),
                signal,
              );
              await removeSessionMember(scope, member.id);
              release.resolve();
              await expect(pending).rejects.toThrow("admitted run authority is no longer active");
              expect(requests).toHaveLength(2);
              await expect(forkAs(member.id)).rejects.toThrow(/not found/i);
              expect(requests).toHaveLength(2);
            } finally {
              release.resolve();
              await Promise.allSettled([pending]);
            }
          } finally {
            lifetime.abort();
            await disposeSessionReadContexts();
            await resetPreparedModelRuntimeSnapshotsForTest();
            await closeProviderTransportDispatcherPool();
            resetCommandQueueStateForTest();
            resetConfigRuntimeState();
            clearPluginMetadataLifecycleCaches();
            resetPluginLoaderTestStateForTest();
          }
        },
      );
    } finally {
      lifetime.abort();
      listener.closeAllConnections();
      try {
        await releaseListener();
      } finally {
        await claim.release();
      }
    }
  });
});
