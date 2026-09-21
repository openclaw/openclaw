// Imported after the shared Gateway harness installs its model-boundary mocks.
import { expectDefined, isRecord } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolsInvokeResult } from "../../../packages/gateway-protocol/src/index.js";
import { prepareAgentCommandExecutionIdentity } from "../../agents/agent-command-execution-identity.js";
import type { AgentCommandGatewayIngressOpts } from "../../agents/command/types.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { callInProcessGatewayTool } from "../../agents/tools/in-process-gateway.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { hasAgentRunContextExecutionOwner } from "../../infra/agent-run-registry.js";
import * as mutationAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { withPluginRuntimeGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import {
  ensureGatewayOwnerProfile,
  ensureProfileForEmail,
  getUserProfileListItem,
  linkEmail,
  setUserProfileRole,
} from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  captureGatewayDeviceRevocation,
  closeGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "../device-revocation.js";
import { ADMIN_SCOPE, WRITE_SCOPE } from "../operator-scopes.js";
import { handleGatewayRequest } from "../server-methods.js";
import {
  describe1AfterEach1,
  describe1BeforeEach0,
  getAgentTestMocks,
  makeContext,
  operatorWriteCliClient,
  prime,
  waitForAgentCommandCall,
  waitForAssertion,
} from "./agent.test-harness.js";
import {
  createAccessPolicyTransport,
  createVisitorGatewayConfig,
  createVisitorGrantStore,
  startVisitorGateway,
  visitorTestStateOptions,
  type Grant,
} from "./agent.visitor-access.test-support.js";
import type { GatewayClient } from "./types.js";

const SESSION_KEY = "agent:main:main";
const SESSION_ID = "existing-session-id";
const EMAIL = "visitor@example.test";

describe("visitor access admitted caller", () => {
  beforeEach(describe1BeforeEach0);
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await describe1AfterEach1();
  });

  it.each(["admin", "writer", "revoked before commit", "revoked after commit"] as const)(
    "retains the original caller through Visitor Access: %s",
    async (scenario) => {
      await withOpenClawTestState(visitorTestStateOptions, async (state) => {
        const config = createVisitorGatewayConfig(state.workspaceDir);
        await state.writeConfig(config);
        setRuntimeConfigSnapshot(config);
        const mocks = getAgentTestMocks();
        mocks.loadConfigReturn = config;
        const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
        mocks.userTurnStorePath = storePath;
        await upsertSessionEntryCore(
          { storePath, sessionKey: SESSION_KEY, agentId: "main" },
          {
            sessionId: SESSION_ID,
            updatedAt: Date.now(),
            visibility: "shared",
          },
        );
        prime(SESSION_ID, config);
        const profile = setUserProfileRole(
          ensureProfileForEmail("source@example.test").id,
          scenario === "writer" ? "writer" : "admin",
        );
        const provider = createAccessPolicyTransport();
        vi.stubGlobal("fetch", provider.fetcher);
        let gateway: Awaited<ReturnType<typeof startVisitorGateway>> | undefined;
        const context = makeContext();
        const resolveGatewayContext = () => context;
        context.resolveGatewayContext = resolveGatewayContext;
        const connection = new AbortController();
        const client: GatewayClient = {
          ...operatorWriteCliClient([scenario === "writer" ? WRITE_SCOPE : ADMIN_SCOPE]),
          connectionSignal: connection.signal,
          invalidated: false,
          authenticatedUserId: "source@example.test",
          authenticatedUserProfile: {
            profileId: profile.id,
            displayName: profile.displayName,
            hasAvatar: profile.hasAvatar,
            updatedAt: profile.updatedAt,
          },
          internal: { operatorRoleActor: { kind: "operator", profileId: profile.id } },
        };
        const deviceId = `visitor-source-${scenario}`;
        const caller = captureGatewayDeviceRevocation(
          context,
          { deviceId, role: "operator" },
          () => !client.invalidated,
          connection.signal,
        );
        const grants = createVisitorGrantStore(state.env);
        let previous: Grant | undefined;
        let renewal: PromiseSettledResult<ToolsInvokeResult> | undefined;
        let commitGranted = false;
        const stages: string[] = [];
        let proof: Promise<void> | undefined;
        const replies: Array<{ ok: boolean; payload: unknown; error: unknown }> = [];
        const runId = `visitor-admission-${scenario}`;
        try {
          gateway = await startVisitorGateway({
            config,
            state,
            context,
            resolveGatewayContext,
          });
          const { methods } = gateway;
          provider.fetcher.mockClear();
          mocks.agentCommand.mockImplementation((opts: AgentCommandGatewayIngressOpts) => {
            proof = (async () => {
              const admission = prepareAgentCommandExecutionIdentity({
                opts,
                prepared: {
                  cfg: config,
                  runId,
                  sessionAgentId: "main",
                  sessionId: SESSION_ID,
                  sessionKey: SESSION_KEY,
                },
                ingress: { kind: "gateway-client", boundary: "agent", state: "present" },
                lifecycleGeneration: expectDefined(
                  opts.lifecycleGeneration,
                  "run generation missing",
                ),
              });
              try {
                const admitted = await admission.admit("embedded");
                expect(caller.isCurrent()).toBe(true);
                const identity = createAdmittedGatewayToolCallerIdentity({
                  admittedRunContext: admitted,
                  agentId: "main",
                  sessionKey: SESSION_KEY,
                });
                await withPluginRuntimeGatewayContextResolver(
                  resolveGatewayContext,
                  () =>
                    withGatewayToolCallerIdentity(identity, async () => {
                      const invite = (days: number) =>
                        callInProcessGatewayTool<ToolsInvokeResult>("tools.invoke", {
                          name: "visitor_invite",
                          args: { email: EMAIL, days },
                          sessionKey: SESSION_KEY,
                        });
                      const first = await invite(1);
                      expect(first).toMatchObject({
                        ok: true,
                        source: "plugin",
                        toolName: "visitor_invite",
                      });
                      if (scenario === "writer") {
                        expect(first.output).toMatchObject({
                          isError: true,
                          content: [
                            {
                              type: "text",
                              text: expect.stringContaining("Only administrators"),
                            },
                          ],
                        });
                        return;
                      }
                      expect(first.output).toMatchObject({
                        content: [{ type: "text", text: expect.stringContaining("Invited") }],
                      });
                      previous = expectDefined(
                        await grants.lookup(EMAIL),
                        "invitation was not recorded",
                      );
                      if (scenario === "admin") {
                        return;
                      }
                      const createAdmission =
                        mutationAdmission.createSqliteWorkerOperationAdmission;
                      const revokeSource = () => {
                        expect(hasAgentRunContextExecutionOwner(runId)).toBe(true);
                        invalidateGatewayDeviceRevocation(context, deviceId, "operator");
                        expect(caller.isCurrent()).toBe(false);
                        expect(hasAgentRunContextExecutionOwner(runId)).toBe(true);
                      };
                      const intercept = vi
                        .spyOn(mutationAdmission, "createSqliteWorkerOperationAdmission")
                        .mockImplementation((admit) =>
                          createAdmission((request, grant) => {
                            stages.push(request.stage);
                            if (
                              request.stage === "commit" &&
                              scenario === "revoked before commit"
                            ) {
                              revokeSource();
                            }
                            admit(request, () => {
                              const accepted = grant();
                              if (request.stage === "commit") {
                                commitGranted = accepted;
                              }
                              return accepted;
                            });
                            if (
                              request.stage === "commit" &&
                              scenario === "revoked after commit" &&
                              commitGranted
                            ) {
                              revokeSource();
                            }
                          }),
                        );
                      try {
                        [renewal] = await Promise.allSettled([invite(2)]);
                      } finally {
                        intercept.mockRestore();
                      }
                    }),
                  { inheritRequestScope: false },
                );
              } finally {
                await admission.finish();
              }
            })();
            return proof.then(() => ({ payloads: [{ text: "done" }], meta: { durationMs: 1 } }));
          });
          await handleGatewayRequest({
            req: {
              type: "req",
              id: runId,
              method: "agent",
              params: {
                message: "visitor authority probe",
                sessionKey: SESSION_KEY,
                idempotencyKey: runId,
              },
            },
            context,
            client,
            isWebchatConnect: () => false,
            hasCurrentClientAuthority: caller.isCurrent,
            methodRegistry: methods,
            respond: (ok, payload, error) => {
              replies.push({ ok, payload, error });
              if (isRecord(payload) && payload.status === "accepted") {
                caller.release();
                connection.abort();
              }
            },
          });
          expect(replies, scenario).toContainEqual(
            expect.objectContaining({
              ok: true,
              payload: expect.objectContaining({ status: "accepted" }),
            }),
          );
          await waitForAgentCommandCall();
          try {
            await expectDefined(proof, "admitted visitor proof missing");
          } finally {
            await waitForAssertion(() => expect(context.chatAbortControllers.size).toBe(0));
          }
          expect(mocks.agentCommand).toHaveBeenCalledOnce();
          const saved = await grants.lookup(EMAIL);
          if (scenario === "writer") {
            expect(saved).toBeUndefined();
            expect(provider.fetcher).not.toHaveBeenCalled();
            return;
          }
          expect(provider.emails()).toEqual([EMAIL]);
          expect(provider.writes).toEqual(["POST"]);
          const original = expectDefined(previous, "initial grant missing");
          if (scenario === "admin") {
            expect(saved).toEqual(original);
            expect(original.expiresAt).toBeGreaterThan(original.createdAt);
            return;
          }
          expect(stages).toEqual(["transaction", "commit"]);
          const outcome = expectDefined(renewal, "renewal result missing");
          expect(outcome.status).toBe("rejected");
          if (scenario === "revoked before commit") {
            expect(saved).toEqual(original);
          } else {
            const renewed = expectDefined(saved, "committed renewal was lost");
            expect(renewed.createdAt).toBe(original.createdAt);
            expect(renewed.expiresAt).toBeGreaterThan(original.expiresAt);
          }
          expect(commitGranted).toBe(scenario === "revoked after commit");
        } finally {
          caller.release();
          closeGatewayDeviceRevocation(context);
          await gateway?.stop();
        }
      });
    },
  );

  it("reopens existing profiles and grants under the restricted default", async () => {
    await withOpenClawTestState(visitorTestStateOptions, async (state) => {
      const config = createVisitorGatewayConfig(state.workspaceDir);
      config.tools = { allow: ["visitor_invite", "visitor_list"] };
      const roles = expectDefined(config.gateway?.roles, "Gateway roles missing");
      roles.default = "writer";
      await state.writeConfig(config);
      setRuntimeConfigSnapshot(config);
      const mocks = getAgentTestMocks();
      mocks.loadConfigReturn = config;
      const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
      mocks.userTurnStorePath = storePath;
      await upsertSessionEntryCore(
        { storePath, sessionKey: SESSION_KEY, agentId: "main" },
        { sessionId: SESSION_ID, updatedAt: Date.now(), visibility: "shared" },
      );
      prime(SESSION_ID, config);
      const owner = getUserProfileListItem(ensureGatewayOwnerProfile("Existing owner").id);
      const staffId = ensureProfileForEmail("staff@example.test").id;
      setUserProfileRole(staffId, "writer");
      const staff = linkEmail("staff-alias@example.test", staffId);
      const now = Date.now();
      const day = 86_400_000;
      const active = {
        email: "staff-alias@example.test",
        githubLogin: "existing-staff",
        invitedVia: SESSION_KEY,
        createdAt: now - 7 * day,
        expiresAt: now + day,
      };
      const expired = {
        email: "expired-visitor@example.test",
        invitedVia: SESSION_KEY,
        createdAt: now - 7 * day,
        expiresAt: now - day,
      };
      const unmanaged = "dashboard-only@example.test";
      const provider = createAccessPolicyTransport([active.email, expired.email, unmanaged]);
      vi.stubGlobal("fetch", provider.fetcher);
      const previousContext = makeContext();
      const resolvePreviousContext = () => previousContext;
      previousContext.resolveGatewayContext = resolvePreviousContext;
      const previousGateway = await startVisitorGateway({
        config,
        state,
        context: previousContext,
        resolveGatewayContext: resolvePreviousContext,
      });
      try {
        const existing = createVisitorGrantStore(state.env);
        await existing.register(active.email, active);
        await existing.register(expired.email, expired);
        expect(provider.writes).toEqual([]);
      } finally {
        closeGatewayDeviceRevocation(previousContext);
        await previousGateway.stop();
      }
      await closeOpenClawStateDatabaseAsync();

      const restrictedConfig: OpenClawConfig = {
        ...config,
        gateway: { ...config.gateway, roles: { ...roles, default: "guest" } },
      };
      await state.writeConfig(restrictedConfig);
      setRuntimeConfigSnapshot(restrictedConfig);
      mocks.loadConfigReturn = restrictedConfig;
      prime(SESSION_ID, restrictedConfig);
      const context = makeContext();
      const resolveGatewayContext = () => context;
      context.resolveGatewayContext = resolveGatewayContext;
      const gateway = await startVisitorGateway({
        config: restrictedConfig,
        state,
        context,
        resolveGatewayContext,
      });
      try {
        const grants = createVisitorGrantStore(state.env);
        expect((await grants.entries()).map(({ key, value }) => ({ key, value }))).toEqual([
          { key: active.email, value: active },
        ]);
        expect(provider.emails()).toEqual([active.email, unmanaged]);
        expect(provider.writes).toEqual(["PUT"]);
        const reopenedOwner = getUserProfileListItem(owner.id);
        const connection = new AbortController();
        const client: GatewayClient = {
          ...operatorWriteCliClient([ADMIN_SCOPE]),
          connectionSignal: connection.signal,
          invalidated: false,
          authenticatedUserProfile: {
            profileId: reopenedOwner.id,
            displayName: reopenedOwner.displayName,
            hasAvatar: reopenedOwner.hasAvatar,
            updatedAt: reopenedOwner.updatedAt,
          },
          internal: { operatorRoleActor: { kind: "system" } },
        };
        const caller = captureGatewayDeviceRevocation(
          context,
          { deviceId: "reopened-owner", role: "operator" },
          () => !client.invalidated,
          connection.signal,
        );
        try {
          const invoke = async (name: string, args: Record<string, unknown> = {}) => {
            const respond = vi.fn();
            await handleGatewayRequest({
              req: {
                type: "req",
                id: `reopened-${name}`,
                method: "tools.invoke",
                params: { name, args, sessionKey: SESSION_KEY },
              },
              context,
              client,
              isWebchatConnect: () => false,
              hasCurrentClientAuthority: caller.isCurrent,
              methodRegistry: gateway.methods,
              respond,
            });
            expect(respond).toHaveBeenCalledOnce();
            expect(respond.mock.calls[0]?.[0]).toBe(true);
            const payload: unknown = respond.mock.calls[0]?.[1];
            expect(payload).toMatchObject({ ok: true, source: "plugin", toolName: name });
            const output = isRecord(payload) ? payload.output : undefined;
            expect(output).not.toHaveProperty("isError", true);
            const block =
              isRecord(output) && Array.isArray(output.content) ? output.content[0] : undefined;
            if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
              throw new Error("Expected visitor tool text");
            }
            return block.text;
          };
          const listing = await invoke("visitor_list");
          expect(listing).toContain(`${active.email} | @${active.githubLogin}`);
          expect(listing).toContain(`invited ${new Date(active.createdAt).toISOString()}`);
          expect(listing).toContain('Gateway access: existing role "writer" retained');
          expect(listing).toContain(`${unmanaged} | UNMANAGED`);
          expect(listing).not.toContain(expired.email);
          const renewal = await invoke("visitor_invite", { email: active.email, days: 2 });
          expect(renewal).toContain(`Renewed @${active.githubLogin} (${active.email})`);
          expect(renewal).toContain('Gateway access: existing role "writer" retained');
          const renewed = expectDefined(await grants.lookup(active.email), "renewal missing");
          expect(renewed).toEqual({ ...active, expiresAt: expect.any(Number) });
          expect(renewed.expiresAt).toBeGreaterThan(active.expiresAt);
          expect(provider.writes).toEqual(["PUT"]);
          expect(getUserProfileListItem(staffId)).toEqual(staff);
          expect(getUserProfileListItem(owner.id)).toEqual(owner);
        } finally {
          caller.release();
          connection.abort();
          closeGatewayDeviceRevocation(context);
        }
      } finally {
        await gateway.stop();
      }
    });
  });
});
