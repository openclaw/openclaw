import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import * as questionDispatch from "../../agents/harness/gateway-question-dispatch.js";
import { resetPendingAskUserQuestionsForTest } from "../../agents/tools/ask-user-tool.test-support.js";
import type { GatewayQuestionCall } from "../../agents/tools/gateway-question-lifecycle.js";
import * as gatewayTransport from "../../agents/tools/gateway.js";
import { createSecretsTool } from "../../agents/tools/secrets-tool.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import * as runRegistry from "../../infra/agent-run-registry.js";
import * as secretRuntime from "../../secrets/runtime.js";
import * as secretStore from "../../secrets/store/secret-store.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import * as testState from "../../test-utils/openclaw-test-state.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import { QuestionManager } from "../question-manager.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createQuestionHandlers } from "./question.js";
import { createSecretsHandlers, createSecretStoreWriteService } from "./secrets.js";
import type { GatewayClient, RespondFn } from "./types.js";

afterEach(() => {
  secretRuntime.clearSecretsRuntimeSnapshot();
  resetPendingAskUserQuestionsForTest();
  vi.restoreAllMocks();
});

let handlers: ReturnType<typeof createSecretsHandlers>;
let reloadSecrets = vi.fn<Parameters<typeof createSecretsHandlers>[0]["reloadSecrets"]>();
let storeWriteService: ReturnType<typeof createSecretStoreWriteService>;
let log: { debug?: () => void };

async function invoke(
  method: string,
  params: Record<string, unknown>,
  client: GatewayClient | null = null,
) {
  const responses: Parameters<RespondFn>[] = [];
  await handlers[method]!({
    req: { type: "req", id: "store-rpc", method },
    params,
    client,
    respond: (...args) => {
      responses.push(args);
    },
    isWebchatConnect: () => false,
    context: createDirectChatContext({
      validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    }),
  });
  return responses[0];
}

const resolveSecrets = async () => ({ assignments: [], diagnostics: [], inactiveRefPaths: [] });
const scope = { kind: "team" } as const;
const readSecret = (name: string) => secretStore.readSecretStoreValue({ scope, name });
const seedSecret = (name: string, value: string) =>
  secretStore.writeSecretStoreEntry({ scope, name, value, kind: "secret", updatedBy: "test" });

function withState(run: (state: testState.OpenClawTestState) => Promise<void>) {
  return testState.withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    setRuntimeConfigSnapshot({});
    reloadSecrets = vi.fn(async () => ({ warningCount: 0 }));
    log = {};
    storeWriteService = createSecretStoreWriteService({ reloadSecrets });
    handlers = createSecretsHandlers({
      reloadSecrets,
      resolveSecrets,
      storeWriteService,
      log,
    });
    await run(state);
  });
}

function claimRun(name: string) {
  const runId = `${name}-run`;
  const authority = runRegistry.claimAgentRunDelegatedAuthority({
    instanceId: `${name}-instance`,
    runId,
  });
  const identity = {
    kind: "agentRuntime" as const,
    agentId: "main",
    sessionKey: "agent:main:main",
    operationalRunInstance: authority.operationalRunInstance,
    delegatedAuthority: { kind: "local" as const, ...authority },
  };
  return {
    authority,
    identity,
    client: { internal: { agentRuntimeIdentity: identity } } as GatewayClient,
    close: () => {
      runRegistry.releaseAgentRunDelegatedAuthority(authority);
      runRegistry.clearAgentRunContext(runId);
    },
  };
}

describe("secret store mutation lifecycle", () => {
  it("rejects sentinel writes without replacing credentials", async () => {
    await withState(async () => {
      const name = "OPENCLAW_GATEWAY_TOKEN";
      const value = "synthetic-gateway-token";
      await seedSecret(name, value);

      expect(
        await invoke("secrets.store.set", {
          name,
          value: "__OPENCLAW_REDACTED__",
          kind: "secret",
        }),
      ).toMatchObject([
        false,
        undefined,
        { code: "INVALID_REQUEST", message: expect.stringContaining(name) },
      ]);
      expect(await readSecret(name)).toEqual({ ok: true, value });
      expect(reloadSecrets).not.toHaveBeenCalled();
    });
  });

  it.each(["dispatch continuation", "mutation logging"] as const)(
    "rejects delete after %s revokes authority",
    async (closure) => {
      await withState(async () => {
        const name = "SYNTHETIC_DELETE_KEY";
        const value = "test-secret-delete-must-survive";
        await seedSecret(name, value);
        const run = claimRun("delete");
        const { authority, identity, client } = run;
        log.debug = () => {
          if (closure === "mutation logging") {
            runRegistry.releaseAgentRunDelegatedAuthority(authority);
          }
        };
        try {
          expect(createAgentRuntimeApprovalAuthorityValidator()(identity)).toBe(true);
          const dispatched = Promise.resolve().then(() =>
            invoke("secrets.store.delete", { name }, client),
          );
          if (closure === "dispatch continuation") {
            runRegistry.releaseAgentRunDelegatedAuthority(authority);
          }
          expect(await dispatched).toMatchObject([false, undefined, { code: "INVALID_REQUEST" }]);
          expect(await readSecret(name)).toEqual({ ok: true, value });
          expect(reloadSecrets).not.toHaveBeenCalled();
          // A normal human administrator has no delegated run claim to revoke.
          expect(await invoke("secrets.store.delete", { name })).toMatchObject([
            true,
            { ok: true },
          ]);
          expect((await readSecret(name)).ok).toBe(false);
        } finally {
          run.close();
        }
      });
    },
  );

  it("reports committed operator policy without secrets", async () => {
    await withState(async () => {
      const run = claimRun("tool");
      const client = {
        ...run.client,
        connect: { scopes: ["operator.admin"] },
      } as GatewayClient;
      const scheduler = createTestGatewayScheduler();
      const manager = new QuestionManager(scheduler);
      handlers = {
        ...createQuestionHandlers(manager, storeWriteService, scheduler),
        ...handlers,
      };
      const methods: string[] = [];
      try {
        const gatewayCall: GatewayQuestionCall = async (method, _options, params) => {
          methods.push(method);
          const response = await invoke(method, params as Record<string, unknown>, client);
          if (!response?.[0]) {
            throw new Error("synthetic question RPC failed");
          }
          if (method === "question.request") {
            const { id } = response[1] as { id: string };
            expect(
              await invoke("question.resolve", {
                id,
                answers: { answers: { secret_value: ["test-secret-operator-only"] } },
                secretStoreAllowedHosts: ["approved.example.test"],
              }),
            ).toMatchObject([true, { status: "answered" }, undefined]);
          }
          return response[1];
        };
        vi.spyOn(gatewayTransport, "callGatewayTool").mockImplementation(gatewayCall);
        vi.spyOn(questionDispatch, "resolveAgentQuestionGatewayCall").mockReturnValue(gatewayCall);
        const tool = createSecretsTool({
          agentId: "main",
          sessionKey: "agent:main:main",
          runId: "tool-run",
        });
        const result = await tool.execute("policy-change", {
          action: "request",
          name: "APPROVED_POLICY_KEY",
          allowedHosts: ["proposed.example.test"],
        });
        expect(await secretStore.listSecretStoreEntries({ scope })).toMatchObject([
          { name: "APPROVED_POLICY_KEY", allowedHosts: ["approved.example.test"] },
        ]);
        expect(result.details).toEqual({
          status: "stored",
          name: "APPROVED_POLICY_KEY",
          kind: "secret",
          ref: { source: "store", provider: "default", id: "APPROVED_POLICY_KEY" },
          currentPolicy: { status: "available", allowedHosts: ["approved.example.test"] },
        });
        expect(JSON.stringify(result)).not.toContain("proposed.example.test");
        expect(JSON.stringify(result)).not.toContain("test-secret-operator-only");
        expect(methods).toEqual(["question.request", "question.waitAnswer", "secrets.store.list"]);
      } finally {
        manager.close();
        run.close();
      }
    });
  });

  it.each(["api_key", "token"] as const)(
    "refreshes auth-profile %s refs on create, rotate, and delete",
    async (type) => {
      await withState(async (state) => {
        const name = "AUTH_PROFILE_ONLY_KEY";
        const ref = { source: "store", provider: "default", id: name } as const;
        const profileId = "custom:store";
        const store: AuthProfileStore = {
          version: 1,
          profiles: {
            [profileId]:
              type === "api_key"
                ? { type, provider: "custom", keyRef: ref }
                : { type, provider: "custom", tokenRef: ref },
          },
        };
        const runtimeOptions = {
          config: {},
          env: { OPENCLAW_STATE_DIR: state.stateDir },
          agentDirs: [state.agentDir()],
          includeConfigRefs: false,
          loadAuthStore: () => store,
          manifestRegistry: { plugins: [] },
          allowUnavailableSecretOwners: true,
        };
        secretRuntime.activateSecretsRuntimeSnapshot(
          await secretRuntime.prepareSecretsRuntimeSnapshot(runtimeOptions),
        );
        const currentCredential = () => {
          const profile =
            secretRuntime.getActiveSecretsRuntimeSnapshot()?.authStores[0]?.store.profiles[
              profileId
            ];
          return profile?.type === "api_key"
            ? profile.key
            : profile?.type === "token"
              ? profile.token
              : undefined;
        };
        const expectCold = () => {
          expect(currentCredential()).toBeUndefined();
          expect(secretRuntime.getActiveSecretsRuntimeSnapshot()?.degradedOwners).toMatchObject([
            { ownerKind: "account", degradationState: "cold" },
          ]);
        };
        expectCold();
        reloadSecrets.mockImplementation(
          async (options?: { forceColdRefKeys?: ReadonlySet<string> }) => {
            const snapshot = await secretRuntime.prepareSecretsRuntimeSnapshot({
              ...runtimeOptions,
              forceColdRefKeys: options?.forceColdRefKeys,
            });
            secretRuntime.activateSecretsRuntimeSnapshot(snapshot);
            return { warningCount: snapshot.warnings.length };
          },
        );
        for (const value of ["test-secret-created", "test-secret-rotated"]) {
          expect(await invoke("secrets.store.set", { name, value, kind: "secret" })).toMatchObject([
            true,
            { ok: true, reloaded: true },
          ]);
          expect(currentCredential()).toBe(value);
        }
        expect(reloadSecrets).toHaveBeenLastCalledWith({
          forceColdRefKeys: new Set([`store:default:${name}`]),
          joinInFlight: false,
        });
        expect(await invoke("secrets.store.delete", { name })).toMatchObject([
          true,
          { ok: true, reloaded: true },
        ]);
        expectCold();
        expect(reloadSecrets).toHaveBeenCalledTimes(3);
        // Environment entries remain an operator-owned write path, and unrelated
        // names must not refresh every auth profile on the Gateway.
        expect(
          await invoke("secrets.store.set", {
            name: "UNRELATED_SETTING",
            value: "enabled",
            kind: "env",
          }),
        ).toMatchObject([true, { ok: true, reloaded: false }]);
        expect(reloadSecrets).toHaveBeenCalledTimes(3);
        expect(await readSecret("UNRELATED_SETTING")).toEqual({ ok: true, value: "enabled" });
        secretRuntime.clearSecretsRuntimeSnapshot();
      });
    },
  );
});
