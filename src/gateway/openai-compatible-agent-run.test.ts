import assert from "node:assert/strict";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  readAdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import { agentCommandFromGatewayIngress } from "../commands/agent.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as profileReader from "../state/user-profile-list.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  readOpenAiHttpRunTerminal,
  runOpenAiCompatibleAgentCommand,
} from "./openai-compatible-agent-run.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";

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
      authenticatedUserProfile: {
        profileId: person.id,
        displayName: person.displayName,
        hasAvatar: false,
        updatedAt: person.updatedAt,
      },
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
      if (change === "missing host") {
        fixture.params.resolveGatewayContext = undefined;
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
        return { payloads: [{ text: "settled", mediaUrl: null }], meta: { durationMs: 0 } };
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
