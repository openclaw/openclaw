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
import { ensureProfileForEmail, setUserProfileRole } from "../state/user-profiles.js";
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

describe("OpenAI-compatible operator run authority", () => {
  beforeEach(() => {
    vi.mocked(agentCommandFromGatewayIngress).mockReset();
  });

  it.each([false, true])(
    "retains the original source through command settlement and detached work (reject=%s)",
    async (reject) => {
      await withOpenClawTestState({ label: "compat-run-retention" }, async () => {
        const fixture = createOperatorRunFixture();
        const entered = createDeferred<CommandOptions>();
        const settlement = createDeferred<typeof completedResult>();
        const failure = new Error("command failed");
        vi.mocked(agentCommandFromGatewayIngress).mockImplementation(async (options) => {
          entered.resolve(options);
          return await settlement.promise;
        });
        const running = runOpenAiCompatibleAgentCommand(fixture.params);
        let child: ReturnType<typeof prepareAgentRunAdmission> | undefined;
        try {
          const options = await Promise.race([
            entered.promise,
            running.then(() => {
              throw new Error("Command finished without receiving operator authority");
            }),
          ]);
          const authority = options.operatorAuthority;
          if (!authority) {
            throw new Error("Expected the original operator authority");
          }
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
          if (!childAuthority) {
            throw new Error("Detached work lost its original operator authority");
          }
          expect(() => childAuthority.assertCurrent()).not.toThrow();
          child.close();
          expect(() => authority.assertCurrent()).toThrow(/no longer active/);
        } finally {
          settlement.resolve(completedResult);
          await running.catch(() => {});
          child?.close();
        }
      });
    },
  );

  it.each(["grant", "role", "host"] as const)(
    "rejects retained effects and late results after the original %s changes",
    async (changed) => {
      await withOpenClawTestState({ label: "compat-run-currentness" }, async () => {
        const fixture = createOperatorRunFixture();
        const entered = createDeferred<CommandOptions>();
        const settlement = createDeferred<typeof completedResult>();
        vi.mocked(agentCommandFromGatewayIngress).mockImplementation(async (options) => {
          entered.resolve(options);
          return await settlement.promise;
        });
        const running = runOpenAiCompatibleAgentCommand(fixture.params);
        try {
          const options = await Promise.race([
            entered.promise,
            running.then(() => {
              throw new Error("Command finished before the authority change");
            }),
          ]);
          if (!options.operatorAuthority) {
            throw new Error("Expected the original operator authority");
          }
          if (changed === "grant") {
            fixture.source.abort(new Error("Visitor access ended"));
            expect(options.abortSignal?.aborted).toBe(true);
          } else if (changed === "role") {
            setUserProfileRole(fixture.person.id, "blocked");
            invalidateOperatorRolePolicy(fixture.person.id);
          } else {
            fixture.host.current = createGatewayRequestContext(makeContextParams());
          }
          expect(() => options.operatorAuthority!.assertCurrent()).toThrow();
          settlement.resolve(completedResult);
          await expect(running).rejects.toThrow();
        } finally {
          settlement.resolve(completedResult);
          await running.catch(() => {});
        }
      });
    },
  );

  it("preserves retained authority through tentative config and reads only committed role changes", async () => {
    await withOpenClawTestState({ label: "compat-run-committed-config" }, async () => {
      const fixture = createOperatorRunFixture();
      const context = fixture.host.current;
      if (!context) {
        throw new Error("Expected the current Gateway context");
      }
      const restricted: OpenClawConfig = {
        gateway: {
          roles: {
            default: "blocked",
            definitions: { blocked: { sessions: { others: "none" }, agents: [], scopes: [] } },
          },
        },
      };
      let tentative = fixture.cfg;
      let committed = fixture.cfg;
      context.getRuntimeConfig = () => tentative;
      context.getCommittedRuntimeConfig = () => committed;
      const entered = createDeferred<CommandOptions>();
      const settlement = createDeferred<typeof completedResult>();
      vi.mocked(agentCommandFromGatewayIngress).mockImplementation(async (options) => {
        entered.resolve(options);
        return await settlement.promise;
      });
      const running = runOpenAiCompatibleAgentCommand(fixture.params);
      try {
        const options = await Promise.race([
          entered.promise,
          running.then(() => {
            throw new Error("Command finished before the config change");
          }),
        ]);
        const authority = options.operatorAuthority;
        if (!authority) {
          throw new Error("Expected the original operator authority");
        }
        tentative = restricted;
        expect(() => authority.assertCurrent()).not.toThrow();
        tentative = fixture.cfg;
        expect(() => authority.assertCurrent()).not.toThrow();
        committed = restricted;
        expect(() => authority.assertCurrent()).toThrow();
        settlement.resolve(completedResult);
        await expect(running).rejects.toThrow();
      } finally {
        settlement.resolve(completedResult);
        await running.catch(() => {});
      }
    });
  });

  it.each(["missing host", "closed host", "ended grant"] as const)(
    "does not enter the command for a person with %s",
    async (missing) => {
      await withOpenClawTestState({ label: "compat-run-admission" }, async () => {
        const fixture = createOperatorRunFixture();
        if (missing === "missing host") {
          fixture.params.resolveGatewayContext = undefined;
        } else if (missing === "closed host") {
          fixture.host.current = undefined;
        } else {
          fixture.source.abort(new Error("Visitor access ended"));
        }
        await expect(runOpenAiCompatibleAgentCommand(fixture.params)).rejects.toThrow();
        expect(agentCommandFromGatewayIngress).not.toHaveBeenCalled();
      });
    },
  );

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

describe("OpenAI-compatible agent run terminal metadata", () => {
  it.each([undefined, null, "invalid", [], { pendingToolCalls: "invalid" }])(
    "treats malformed metadata as having no pending calls: %j",
    (meta) => {
      expect(readOpenAiHttpRunTerminal({ meta })).toMatchObject({
        runFailed: false,
        pendingToolCalls: undefined,
      });
    },
  );

  it("filters malformed calls and normalizes the valid calls for both HTTP protocols", () => {
    expect(
      readOpenAiHttpRunTerminal({
        meta: {
          stopReason: "tool_calls",
          pendingToolCalls: [
            null,
            { id: 7, name: "ignored", arguments: "{}" },
            { id: " call_1 ", name: " get_weather ", arguments: { city: "Taipei" } },
          ],
        },
      }),
    ).toEqual({
      runFailed: false,
      stopReason: "tool_calls",
      pendingToolCalls: [{ id: "call_1", name: "get_weather", arguments: '{"city":"Taipei"}' }],
    });
  });

  it("ignores a malformed stop reason without discarding valid calls", () => {
    expect(
      readOpenAiHttpRunTerminal({
        meta: {
          stopReason: 42,
          pendingToolCalls: [{ id: "call_1", name: "get_weather", arguments: "{}" }],
        },
      }),
    ).toMatchObject({
      stopReason: undefined,
      pendingToolCalls: [{ id: "call_1", name: "get_weather", arguments: "{}" }],
    });
  });
});
