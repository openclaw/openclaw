import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createAdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { createAgentHarnessHostCapabilities } from "../agents/harness/host-capability.js";
import { withPreparedEmbeddedRunToolAuthority } from "../agents/harness/tool-authority.runtime.js";
import type { AgentHarness, AgentHarnessAttemptParamsV2 } from "../agents/harness/types.js";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { AuthStorage, ModelRegistry, SessionManager } from "../plugin-sdk/agent-sessions.js";
import { createTestPluginApi } from "../plugin-sdk/plugin-test-api.js";
import { createPluginRuntimeMock } from "../plugin-sdk/plugin-test-runtime.js";
import type * as ProviderAuthRuntime from "../plugin-sdk/provider-auth-runtime.js";
import type * as TranscriptRuntime from "../plugin-sdk/session-transcript-runtime.js";
import type { PluginStateKeyedStore } from "../plugin-state/plugin-state-store.types.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-context-binding.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import type { OpenClawPluginDefinition } from "../plugins/types.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GatewayRequestOptions } from "./server-methods/types.js";
import {
  createContext,
  createOperatorClient,
} from "./server-plugin-in-process-dispatch.test-support.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

vi.mock("../plugin-sdk/provider-auth-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ProviderAuthRuntime>()),
  resolveApiKeyForProvider: async () => ({ apiKey: "synthetic-pool-key" }),
}));
vi.mock("../plugin-sdk/session-transcript-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof TranscriptRuntime>()),
  appendSessionTranscriptMessagesByIdentity: async (params: { messages: unknown[] }) =>
    params.messages,
  publishSessionTranscriptUpdateByIdentity: async () => undefined,
}));
beforeEach(() => {
  vi.spyOn(SessionManager, "openModelContextAsync").mockResolvedValue(SessionManager.inMemory());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(["full", "narrow"] as const)(
  "uses the current %s approval owner after reusing a pooled native peer",
  async (mode) => {
    await withOpenClawTestState({ scenario: "minimal", layout: "split" }, async (state) => {
      const effect = join(state.root, "native-approved-effect");
      const log = join(state.root, "native-requests.jsonl");
      vi.stubEnv("MUSE_FIXTURE_EFFECT_PATH", effect);
      vi.stubEnv("MUSE_REQUEST_LOG", log);
      const config = {};
      setRuntimeConfigSnapshot(config);
      const openKeyedStore = <T>(): PluginStateKeyedStore<T> => {
        const values = new Map<string, T>();
        return {
          register: async (key, value, options) => {
            options?.assertCurrent?.();
            values.set(key, value);
          },
          registerIfAbsent: async (key, value) => {
            if (values.has(key)) {
              return false;
            }
            values.set(key, value);
            return true;
          },
          lookup: async (key) => values.get(key),
          consume: async (key) => {
            const value = values.get(key);
            values.delete(key);
            return value;
          },
          delete: async (key) => values.delete(key),
          entries: async () => [...values].map(([key, value]) => ({ key, value, createdAt: 0 })),
          clear: async () => {
            values.clear();
          },
        };
      };
      const { default: plugin } = await loadBundledPluginFacade<{
        default: OpenClawPluginDefinition;
      }>({ pluginId: "muse", artifactBasename: "index.js" });
      let harness: AgentHarness | undefined;
      if (!plugin.register) {
        throw new Error("Muse public registration missing");
      }
      plugin.register(
        createTestPluginApi({
          id: "muse",
          config,
          pluginConfig: {
            binaryPath: fileURLToPath(
              new URL("../../extensions/muse/src/test-support/fake-muse.mjs", import.meta.url),
            ),
          },
          runtime: createPluginRuntimeMock({ state: { openKeyedStore } }),
          registerAgentHarness: (registered) => {
            harness = registered;
          },
        }),
      );
      if (!harness) {
        throw new Error("Muse harness was not registered");
      }
      const native = harness;
      const callbackContexts: Array<{ actor: string | undefined; scopes: string[] }> = [];
      const dispatches: Array<{ run: unknown; scopes: string[] }> = [];
      const context = createContext(
        [
          [
            "plugin.approval.request",
            "operator.approvals",
            "approvals",
            async ({ client, respond }: GatewayRequestOptions) => {
              dispatches.push({
                run: getGatewayToolCallerIdentity()?.operationalRunInstance,
                scopes: client?.connect.scopes ?? [],
              });
              respond(true, { id: "synthetic-approved-request", decision: "allow-once" });
            },
          ],
        ],
        () => config,
      );
      const resolver = () => context;
      context.resolveGatewayContext = resolver;
      const profileId = ensureProfileForEmail("native-pool-owner@example.test").id;
      const system = createSyntheticPluginRuntimeClient({ operatorRoleActor: { kind: "system" } });
      system.connect = { ...system.connect, scopes: ["operator.read"] };
      const sourceClient = createOperatorClient({
        profileId,
        scopes: ["operator.read", "operator.write", "operator.approvals"],
      });
      const authStorage = AuthStorage.inMemory();
      const base: Omit<AgentHarnessAttemptParamsV2, "hostCapabilities"> = {
        runId: randomUUID(),
        sessionId: randomUUID(),
        sessionKey: "agent:main:pooled-approval",
        agentId: "main",
        workspaceDir: state.workspaceDir,
        agentDir: state.agentDir(),
        config,
        provider: "meta",
        modelId: "muse-spark-1.3",
        model: {
          id: "muse-spark-1.3",
          name: "Fixture",
          provider: "meta",
          api: "openai-responses",
          baseUrl: "https://fixture.invalid",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
        },
        authStorage,
        modelRegistry: ModelRegistry.inMemory(authStorage),
        thinkLevel: "off",
        sessionFile: join(state.root, "transcript.jsonl"),
        timeoutMs: 5000,
        prompt: "hello",
        authProfileStore: { version: 1, profiles: {} },
      };
      base.sessionTarget = {
        sessionId: base.sessionId,
        sessionKey: base.sessionKey,
        storePath: join(state.root, "sessions.json"),
      };
      let expectedRun: unknown;
      async function run(prompt: string, warmup: boolean) {
        const client = (mode === "full") === warmup ? system : sourceClient;
        const runId = randomUUID();
        const authority = createAdmittedRunOperatorAuthority({
          profileId,
          scopes: sourceClient.connect.scopes ?? [],
          assertCurrent: () => {},
        });
        const operationalRunInstance = createOperationalRunInstanceRef(runId);
        if (!warmup) {
          expectedRun = operationalRunInstance;
        }
        const admission = prepareAgentRunAdmission({
          cfg: config,
          facts: {
            runId,
            agentId: "main",
            ingress: { kind: "system", boundary: "pooled-approval-fixture", state: "present" },
          },
          operationalRunInstance,
          operatorAuthority: authority,
        });
        const admitted = await admission.admit("plugin-harness", "muse");
        bindGatewayContextResolver(admitted, resolver);
        const attempt = { ...base, runId, prompt, admittedRunContext: admitted };
        return await withPluginRuntimeGatewayRequestScope(
          { client, context, resolveGatewayContext: resolver, isWebchatConnect: () => false },
          async () => {
            const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "muse" });
            try {
              const params = {
                ...base,
                runId,
                prompt,
                hostCapabilities: {
                  ...host.capabilities,
                  requestApproval: (
                    request: Parameters<typeof host.capabilities.requestApproval>[0],
                  ) => {
                    const scope = getPluginRuntimeGatewayRequestScope();
                    callbackContexts.push({
                      actor: scope?.client?.internal?.operatorRoleActor?.kind,
                      scopes: scope?.client?.connect.scopes ?? [],
                    });
                    return host.capabilities.requestApproval(request);
                  },
                },
              };
              return await withPreparedEmbeddedRunToolAuthority(
                { admittedRunContext: admitted },
                params,
                undefined,
                (prepared) => host.runWithScope(() => native.runAttempt(prepared)),
              );
            } finally {
              host.close();
              admission.close();
            }
          },
        );
      }
      try {
        const warmup = await run("hello", true);
        expect("terminal" in warmup && warmup.terminal).toMatchObject({ kind: "ok" });
        const result = await run("approval", false);
        const requests = (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(requests.filter((entry) => entry.event === "spawn")).toHaveLength(1);
        expect(requests.filter((entry) => entry.method === "session/start")).toHaveLength(1);
        expect(requests.filter((entry) => entry.method === "turn/start")).toHaveLength(2);
        if (mode === "full") {
          expect("terminal" in result && result.terminal).toMatchObject({ kind: "ok" });
          expect(callbackContexts).toEqual([
            { actor: undefined, scopes: ["operator.read", "operator.write", "operator.approvals"] },
          ]);
          expect(dispatches).toHaveLength(1);
          expect(dispatches[0]?.run).toBe(expectedRun);
          expect(dispatches[0]?.scopes).toContain("operator.approvals");
          expect(await readFile(effect, "utf8")).toBe("approved native effect");
          expect(
            requests
              .filter((entry) => entry.method === "approval/decide")
              .map((entry) => entry.params.choiceId),
          ).toEqual(["server-allow-id"]);
        } else {
          expect("terminal" in result && result.terminal).toMatchObject({
            kind: "failed",
            error: expect.objectContaining({
              message: expect.stringContaining("missing scope: operator.approvals"),
            }),
          });
          expect(callbackContexts).toEqual([{ actor: "system", scopes: ["operator.read"] }]);
          expect(dispatches).toEqual([]);
          await expect(readFile(effect, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        }
      } finally {
        await native.dispose?.();
      }
    });
  },
  30000,
);
