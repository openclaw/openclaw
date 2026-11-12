import assert from "node:assert/strict";
import { ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  readAdmittedRunOperatorAuthority,
  type AdmittedRunContext,
} from "../agents/admitted-run-context.js";
import { FailoverError } from "../agents/failover-error.js";
import { agentCommandFromGatewayIngress } from "../commands/agent.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createAbortError } from "../infra/abort-signal.js";
import * as profileReader from "../state/user-profile-list.js";
import { ensureCanonicalUserProfileForOpenClawIdIdentity } from "../state/user-profile-openclaw-id.js";
import { ensureCanonicalGatewayOwnerProfile } from "../state/user-profile-writes.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayRequest } from "./hooks-test-helpers.js";
import { authorizeScopedGatewayHttpRequestOrReply } from "./http-auth-utils.js";
import { authorizeOpenAiCompatibleHttpSession } from "./http-utils.js";
import { markGatewayIngressTransport } from "./ingress-attribution.js";
import {
  readOpenAiHttpRunTerminal,
  resolveOpenAiCompatibleAgentError,
  runOpenAiCompatibleAgentCommand,
} from "./openai-compatible-agent-run.js";
import {
  setOpenClawIdTunnelPrincipalLookup,
  setOpenClawIdTunnelPrincipalResolver,
  type OpenClawIdTunnelPrincipal,
} from "./openclaw-id/tunnel-principal.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import { gatewayProfile } from "./server/client-fixtures.test-support.js";
import * as sessionSharing from "./session-sharing-read.js";

vi.mock("../commands/agent.js", () => ({ agentCommandFromGatewayIngress: vi.fn() }));

const completedResult = { payloads: [], meta: { durationMs: 0 } };
type CommandOptions = Parameters<typeof agentCommandFromGatewayIngress>[0];

function createOperatorRunFixture() {
  const cfg: OpenClawConfig = {
    gateway: {
      roles: {
        default: "visitor",
        definitions: {
          visitor: {
            sessions: { others: "view" },
            agents: ["main"],
            scopes: ["operator.sessions.read", "operator.sessions.write"],
            sandbox: "required",
          },
          blocked: { sessions: { others: "none" }, agents: [], scopes: [] },
        },
      },
    },
  };
  setRuntimeConfigSnapshot(cfg);
  const person = ensureProfileForEmail("visitor@example.test");
  const source = new AbortController();
  const request = new AbortController();
  const host: { current?: GatewayRequestContext } = {
    current: createGatewayRequestContext(makeContextParams()),
  };
  const params: Parameters<typeof runOpenAiCompatibleAgentCommand>[0] = {
    message: "Continue my work",
    sessionKey: "agent:main:visitor-work",
    runId: "compat-request",
    messageChannel: "webchat",
    senderIsOwner: false,
    operatorScopes: ["operator.sessions.write"],
    requestAuth: {
      authMethod: "trusted-proxy",
      trustDeclaredOperatorScopes: true,
      authenticatedUserProfile: gatewayProfile(person.id, person.displayName, person.updatedAt),
      operatorAccessAuthority: {
        signal: source.signal,
        assertCurrent: () => source.signal.throwIfAborted(),
      },
    },
    abortSignal: request.signal,
    resolveGatewayContext: () => host.current,
  };
  return { cfg, params, person, source, request, host };
}

function startPendingCommand(params: Parameters<typeof runOpenAiCompatibleAgentCommand>[0]) {
  const entered = createDeferred<CommandOptions>();
  const settlement = createDeferred<typeof completedResult>();
  vi.mocked(agentCommandFromGatewayIngress).mockImplementation(async (options) => {
    entered.resolve(options);
    return await settlement.promise;
  });
  const running = runOpenAiCompatibleAgentCommand(params);
  return {
    settlement,
    running,
    entered: Promise.race([
      entered.promise,
      running.then(() => {
        throw new Error("Command finished without receiving operator authority");
      }),
    ]),
    close: async () => {
      settlement.resolve(completedResult);
      await running.catch(() => {});
    },
  };
}

describe("OpenAI-compatible operator run authority", () => {
  beforeEach(() => {
    vi.mocked(agentCommandFromGatewayIngress).mockReset();
  });

  it.each(["member", "owner"] as const)(
    "retains the authenticated HTTP %s instead of the named-reader default",
    async (kind) => {
      await withOpenClawTestState({ label: "compat-http-membership" }, async () => {
        const fixture = createOperatorRunFixture();
        fixture.cfg.gateway!.roles = {
          default: "reader",
          definitions: {
            reader: { sessions: { others: "view" }, agents: "*", scopes: ["operator.read"] },
          },
        };
        const principal: OpenClawIdTunnelPrincipal = {
          ...(kind === "member"
            ? { kind, accountId: "acct_compat_operator", role: "operator" as const }
            : { kind }),
          peerKey: `iroh:${"21".repeat(32)}`,
          authority: {
            clawId: "http-claw",
            rootPub: "http-root",
            listedSeq: 1,
            ...(kind === "owner" ? { ownerDevice: "http-owner" } : {}),
          },
        };
        const membership = new Map([[principal.peerKey, principal]]);
        setOpenClawIdTunnelPrincipalResolver(async (key) => membership.get(key));
        setOpenClawIdTunnelPrincipalLookup((key) => membership.get(key));
        const req = createGatewayRequest({ path: "/v1/chat/completions", method: "POST" });
        markGatewayIngressTransport(req, {
          kind: "openclaw-id-tunnel",
          peerKey: principal.peerKey,
          clientIp: "fd69:726f:6800::1",
        });
        const res = new ServerResponse(req);
        let admission: ReturnType<typeof prepareAgentRunAdmission> | undefined;
        let childContext: AdmittedRunContext | undefined;
        try {
          const person =
            principal.kind === "owner"
              ? await ensureCanonicalGatewayOwnerProfile("Synthetic owner")
              : await ensureCanonicalUserProfileForOpenClawIdIdentity({
                  accountId: principal.accountId,
                });
          const authenticated = await authorizeScopedGatewayHttpRequestOrReply({
            req,
            res,
            auth: { mode: "token", token: "test-token", allowTailscale: false },
            cfg: fixture.cfg,
            getRuntimeConfig: () => fixture.cfg,
            operatorMethod: "agent",
          });
          assert(authenticated, "Expected membership to admit the HTTP operator request");
          expect(authenticated.requestAuth.openclawIdPrincipal).toBe(principal);
          expect(authenticated.operatorScopes).toContain("operator.write");
          using sharingProfiles = vi.spyOn(sessionSharing, "prepareSessionSharingProfiles");
          await expect(
            authorizeOpenAiCompatibleHttpSession({
              agentId: "main",
              sessionKey: fixture.params.sessionKey,
              requestAuth: authenticated.requestAuth,
              senderIsOwner: false,
            }),
          ).resolves.toEqual({ allowed: true });
          expect(sharingProfiles.mock.calls[0]?.[0]?.internal?.openclawIdPrincipal).toBe(principal);
          fixture.params.requestAuth = authenticated.requestAuth;
          fixture.params.operatorScopes = authenticated.operatorScopes;
          fixture.params.hasCurrentClientAuthority =
            authenticated.requestAuth.hasCurrentClientAuthority;
          vi.mocked(agentCommandFromGatewayIngress).mockImplementationOnce(async (options) => {
            const authority = options.operatorAuthority;
            assert(authority, "HTTP member did not retain its operator source");
            expect(authority.profileId).toBe(person.id);
            if (kind === "member") {
              expect(authority.readCurrentRoleFacts?.().policy).toMatchObject({
                sessions: { others: "write" },
                scopes: expect.arrayContaining(["operator.write"]),
              });
            }
            expect(authority.recoverySnapshot?.openclawIdPrincipal).toEqual(principal);
            admission = prepareAgentRunAdmission({
              cfg: fixture.cfg,
              facts: {
                runId: "compat-http-child",
                agentId: "main",
                ingress: { kind: "system", boundary: "compat-http-test", state: "present" },
              },
              operationalRunInstance: createOperationalRunInstanceRef("compat-http-child"),
              operatorAuthority: authority,
            });
            childContext = await admission.admit("embedded");
            await options.onAdmittedRunContext?.(childContext);
            return completedResult;
          });
          await expect(runOpenAiCompatibleAgentCommand(fixture.params)).resolves.toBe(
            completedResult,
          );
          assert(childContext, "Expected a retained child admission");
          const authority = readAdmittedRunOperatorAuthority(childContext);
          assert(authority, "Expected retained membership authority");
          res.destroy();
          req.destroy();
          expect(() => authority.assertCurrent()).not.toThrow();
          // Another device for the same account cannot replace this authenticated source.
          membership.clear();
          const replacement = { ...principal, peerKey: `iroh:${"22".repeat(32)}` };
          membership.set(replacement.peerKey, replacement);
          expect(() => authority.assertCurrent()).toThrow(
            /OpenClaw ID membership authority changed/,
          );
        } finally {
          admission?.close();
          res.destroy();
          req.destroy();
          setOpenClawIdTunnelPrincipalResolver(undefined);
          setOpenClawIdTunnelPrincipalLookup(undefined);
        }
      });
    },
  );

  it.each([false, true])(
    "retains the original source through command settlement and detached work (reject=%s)",
    async (reject) => {
      await withOpenClawTestState({ label: "compat-run-retention" }, async () => {
        const fixture = createOperatorRunFixture();
        const { entered, settlement, running, close } = startPendingCommand(fixture.params);
        const failure = new Error("command failed");
        let child: ReturnType<typeof prepareAgentRunAdmission> | undefined;
        try {
          const options = await entered;
          const authority = options.operatorAuthority;
          assert(authority, "Expected the original operator authority");
          expect(authority.profileId).toBe(fixture.person.id);
          expect(authority.scopes).toEqual(["operator.sessions.write"]);
          expect(() => authority.assertCurrent()).not.toThrow();
          child = prepareAgentRunAdmission({
            cfg: fixture.cfg,
            facts: {
              runId: "compat-child",
              agentId: "main",
              ingress: { kind: "system", boundary: "compat-child-test", state: "present" },
            },
            operationalRunInstance: createOperationalRunInstanceRef("compat-child"),
            operatorAuthority: authority,
          });
          const childContext = await child.admit("embedded");
          if (reject) {
            settlement.reject(failure);
            await expect(running).rejects.toBe(failure);
          } else {
            settlement.resolve(completedResult);
            await expect(running).resolves.toBe(completedResult);
          }
          fixture.request.abort();
          expect(options.abortSignal?.aborted).toBe(true);
          expect(authority.signal?.aborted).toBe(false);
          const childAuthority = readAdmittedRunOperatorAuthority(childContext);
          assert(childAuthority, "Detached work lost its original operator authority");
          expect(() => childAuthority.assertCurrent()).not.toThrow();
          child.close();
          expect(() => authority.assertCurrent()).toThrow(/no longer active/);
        } finally {
          await close();
          child?.close();
        }
      });
    },
  );

  it.each(["grant", "role", "host", "committed config"] as const)(
    "rejects retained effects and late results after the original %s changes",
    async (changed) => {
      await withOpenClawTestState({ label: "compat-run-currentness" }, async () => {
        const fixture = createOperatorRunFixture();
        const context = fixture.host.current;
        assert(context, "Expected the current Gateway context");
        let tentative = fixture.cfg;
        let committed = fixture.cfg;
        if (changed === "committed config") {
          context.getRuntimeConfig = () => tentative;
          context.getCommittedRuntimeConfig = () => committed;
        }
        const { entered, settlement, running, close } = startPendingCommand(fixture.params);
        try {
          const options = await entered;
          const authority = options.operatorAuthority;
          assert(authority, "Expected the original operator authority");
          if (changed === "grant") {
            fixture.source.abort(new Error("Visitor access ended"));
            expect(options.abortSignal?.aborted).toBe(true);
          } else if (changed === "role") {
            setUserProfileRole(fixture.person.id, "blocked");
            invalidateOperatorRolePolicy(fixture.person.id);
          } else if (changed === "host") {
            fixture.host.current = createGatewayRequestContext(makeContextParams());
          } else {
            const restricted: OpenClawConfig = {
              gateway: {
                roles: {
                  default: "blocked",
                  definitions: {
                    blocked: { sessions: { others: "none" }, agents: [], scopes: [] },
                  },
                },
              },
            };
            tentative = restricted;
            expect(() => authority.assertCurrent()).not.toThrow();
            tentative = fixture.cfg;
            expect(() => authority.assertCurrent()).not.toThrow();
            committed = restricted;
          }
          expect(() => authority.assertCurrent()).toThrow();
          settlement.resolve(completedResult);
          await expect(running).rejects.toThrow();
        } finally {
          await close();
        }
      });
    },
  );

  it.each([
    { change: "missing host", message: /current Gateway context/ },
    { change: "missing tunnel owner host", message: /current Gateway context/ },
    { change: "closed host", message: /current Gateway context/ },
    { change: "ended grant", message: /Visitor access ended/ },
    { change: "uploads disabled", message: /uploads are disabled/ },
    { change: "request ended", message: /Request ended during preparation/ },
  ])("refuses command admission after $change", async ({ change, message }) => {
    await withOpenClawTestState({ label: "compat-run-admission" }, async () => {
      const fixture = createOperatorRunFixture();
      const preparing = change === "uploads disabled" || change === "request ended";
      fixture.params.hasClientUploads = change === "uploads disabled";
      const entered = createDeferred();
      const resume = createDeferred();
      const prepare = profileReader.prepareUserProfileIdentity;
      const held = preparing
        ? vi
            .spyOn(profileReader, "prepareUserProfileIdentity")
            .mockImplementationOnce(async (...args) => {
              const identity = await prepare(...args);
              entered.resolve();
              await resume.promise;
              return identity;
            })
        : undefined;
      if (change === "missing host" || change === "missing tunnel owner host") {
        fixture.params.resolveGatewayContext = undefined;
        if (change === "missing tunnel owner host") {
          fixture.params.requestAuth.authenticatedUserProfile!.profileId = "gateway-owner";
          fixture.params.requestAuth.openclawIdPrincipal = {
            kind: "owner",
            peerKey: `iroh:${"23".repeat(32)}`,
          };
        }
      } else if (change === "closed host") {
        fixture.host.current = undefined;
      } else if (change === "ended grant") {
        fixture.source.abort(new Error("Visitor access ended"));
      }
      const running = runOpenAiCompatibleAgentCommand(fixture.params);
      const rejected = expect(running).rejects.toThrow(message);
      try {
        if (preparing) {
          await entered.promise;
          if (change === "uploads disabled") {
            setRuntimeConfigSnapshot({
              ...fixture.cfg,
              gateway: { ...fixture.cfg.gateway, uploads: { enabled: false } },
            });
          } else {
            fixture.request.abort(new Error("Request ended during preparation"));
          }
          resume.resolve();
        }
        await rejected;
        expect(agentCommandFromGatewayIngress).not.toHaveBeenCalled();
      } finally {
        resume.resolve();
        await running.catch(() => {});
        held?.mockRestore();
      }
    });
  });

  it("does not revoke already admitted input or its output when uploads are disabled", async () => {
    await withOpenClawTestState({ label: "compat-upload-accepted" }, async () => {
      const fixture = createOperatorRunFixture();
      fixture.params.hasClientUploads = true;
      let admission: ReturnType<typeof prepareAgentRunAdmission> | undefined;
      vi.mocked(agentCommandFromGatewayIngress).mockImplementation(async (options) => {
        admission = prepareAgentRunAdmission({
          cfg: fixture.cfg,
          facts: {
            runId: "compat-upload-accepted",
            agentId: "main",
            ingress: { kind: "system", boundary: "compat-upload-test", state: "present" },
          },
          operationalRunInstance: createOperationalRunInstanceRef("compat-upload-accepted"),
          operatorAuthority: options.operatorAuthority,
        });
        await options.onAdmittedRunContext?.(await admission.admit("embedded"));
        setRuntimeConfigSnapshot({
          ...fixture.cfg,
          gateway: { ...fixture.cfg.gateway, uploads: { enabled: false } },
        });
        options.assertSourceCurrent?.();
        return completedResult;
      });
      try {
        await expect(runOpenAiCompatibleAgentCommand(fixture.params)).resolves.toBe(
          completedResult,
        );
      } finally {
        admission?.close();
      }
    });
  });

  it.each(["owner", "system"] as const)(
    "preserves %s authority without requiring a person-bound Gateway capture",
    async (actor) => {
      await withOpenClawTestState({ label: "compat-run-owner" }, async () => {
        const fixture = createOperatorRunFixture();
        fixture.params.resolveGatewayContext = undefined;
        fixture.params.senderIsOwner = true;
        fixture.params.requestAuth.operatorAccessAuthority = undefined;
        if (actor === "owner") {
          fixture.params.requestAuth.authenticatedUserProfile!.profileId = "gateway-owner";
        } else {
          fixture.params.requestAuth.operatorRoleActor = { kind: "system" };
        }
        vi.mocked(agentCommandFromGatewayIngress).mockImplementation(async (options) => {
          expect(options.operatorAuthority).toBeUndefined();
          expect(options.abortSignal).toBe(fixture.request.signal);
          expect(options.senderIsOwner).toBe(true);
          return completedResult;
        });
        await expect(runOpenAiCompatibleAgentCommand(fixture.params)).resolves.toBe(
          completedResult,
        );
      });
    },
  );
});

describe("OpenAI-compatible command admission", () => {
  it.each([false, true])(
    "keeps authority until custody transfers (already admitted=%s)",
    async (alreadyAdmitted) => {
      const prepared = createDeferred();
      const proceed = createDeferred();
      const executed = vi.fn();
      let current = true;
      vi.mocked(agentCommandFromGatewayIngress).mockImplementationOnce(async (opts) => {
        const context = {
          operationalRunInstance: { runId: "http-run", instanceId: "http-instance" },
        };
        if (alreadyAdmitted) {
          await opts.onAdmittedRunContext?.(context);
        }
        prepared.resolve();
        await proceed.promise;
        opts.assertSourceCurrent?.();
        if (!alreadyAdmitted) {
          await opts.onAdmittedRunContext?.(context);
        }
        executed();
        return {
          payloads: [{ text: "settled", mediaUrl: null }],
          meta: { durationMs: 0, terminalReply: { disposition: "visible", text: "settled" } },
        };
      });
      const pending = runOpenAiCompatibleAgentCommand({
        message: "probe",
        sessionKey: "agent:main:main",
        runId: "http-run",
        messageChannel: "webchat",
        senderIsOwner: true,
        requestAuth: {
          authMethod: "token",
          trustDeclaredOperatorScopes: false,
          operatorRoleActor: { kind: "system" },
        },
        operatorScopes: ["operator.admin"],
        hasCurrentClientAuthority: () => current,
      });
      await prepared.promise;
      current = false;
      proceed.resolve();
      if (alreadyAdmitted) {
        await expect(pending).resolves.toMatchObject({ payloads: [{ text: "settled" }] });
        expect(executed).toHaveBeenCalledOnce();
      } else {
        await expect(pending).rejects.toThrow("Gateway requester authority changed");
        expect(executed).not.toHaveBeenCalled();
      }
    },
  );
});

describe("OpenAI-compatible agent run terminal metadata", () => {
  it.each([
    { meta: undefined, stopReason: undefined, calls: undefined },
    { meta: { pendingToolCalls: "invalid" }, stopReason: undefined, calls: undefined },
    {
      meta: {
        stopReason: "tool_calls",
        pendingToolCalls: [
          null,
          { id: 7, name: "ignored", arguments: "{}" },
          { id: " call_1 ", name: " get_weather ", arguments: { city: "Taipei" } },
        ],
      },
      stopReason: "tool_calls",
      calls: [{ id: "call_1", name: "get_weather", arguments: '{"city":"Taipei"}' }],
    },
    {
      meta: {
        stopReason: 42,
        pendingToolCalls: [{ id: "call_1", name: "get_weather", arguments: "{}" }],
      },
      stopReason: undefined,
      calls: [{ id: "call_1", name: "get_weather", arguments: "{}" }],
    },
  ])(
    "normalizes terminal metadata without accepting malformed calls: $meta",
    ({ meta, stopReason, calls }) => {
      expect(readOpenAiHttpRunTerminal({ meta })).toEqual({
        runFailed: false,
        stopReason,
        pendingToolCalls: calls,
      });
    },
  );
});

describe("OpenAI-compatible agent error envelopes", () => {
  it("gives certificate failure guidance while retaining the native diagnostic code", () => {
    const error = new FailoverError("Connection error.", {
      reason: "tls_certificate",
      code: "CERT_REVOKED",
    });
    expect(resolveOpenAiCompatibleAgentError(error)).toEqual({
      status: 502,
      error: {
        message:
          "Couldn't connect securely to the AI service. For details, open Settings → Logs in the Control UI or run `openclaw logs --follow`.",
        type: "api_error",
        code: "CERT_REVOKED",
      },
    });
  });

  it("projects a local Codex authority refusal as a permission rejection", () => {
    const refusal = new Error(
      "unexpected status 403 Forbidden: Codex cannot verify the owner of this model request. Start a fresh request before retrying., url: http://127.0.0.1:20128/backend-api/codex/responses",
    );
    expect(resolveOpenAiCompatibleAgentError(refusal)).toEqual({
      status: 403,
      error: { message: refusal.message, type: "permission_error" },
    });
  });

  it.each([
    {
      name: "a Gateway-cancelled run",
      error: () => AbortSignal.abort().reason,
      status: 500,
      message: "agent run was cancelled",
    },
    {
      name: "a provider transport timeout",
      error: () => new FailoverError("This operation was aborted", { reason: "timeout" }),
      status: 504,
      message: "upstream provider timeout",
    },
    {
      name: "an abort caused by a timeout",
      error: () =>
        createAbortError("This operation was aborted", {
          cause: new DOMException("The operation was aborted due to timeout", "TimeoutError"),
        }),
      status: 504,
      message: "upstream provider timeout",
    },
  ])("reports $name as $status", ({ error, status, message }) => {
    expect(resolveOpenAiCompatibleAgentError(error())).toEqual({
      status,
      error: { message, type: "api_error" },
    });
  });
});
