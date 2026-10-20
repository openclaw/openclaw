import assert from "node:assert/strict";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  readAdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import { FailoverError } from "../agents/failover-error.js";
import { agentCommandFromGatewayIngress } from "../commands/agent.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createAbortError } from "../infra/abort-signal.js";
import * as profileReader from "../state/user-profile-list.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  readOpenAiHttpRunTerminal,
  resolveOpenAiCompatibleAgentError,
  runOpenAiCompatibleAgentCommand,
} from "./openai-compatible-agent-run.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";

vi.mock("../commands/agent.js", () => ({ agentCommandFromGatewayIngress: vi.fn() }));

const command = vi.mocked(agentCommandFromGatewayIngress);
const completedResult = { payloads: [], meta: { durationMs: 0 } };
type CommandOptions = Parameters<typeof agentCommandFromGatewayIngress>[0];
type RunParams = Parameters<typeof runOpenAiCompatibleAgentCommand>[0];
const systemRun: RunParams = {
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
};
const roleDefinitions = {
  visitor: {
    sessions: { others: "view" },
    agents: ["main"],
    scopes: ["operator.sessions.read", "operator.sessions.write"],
    sandbox: "required",
  },
  blocked: { sessions: { others: "none" }, agents: [], scopes: [] },
} satisfies NonNullable<NonNullable<OpenClawConfig["gateway"]>["roles"]>["definitions"];

function createOperatorRunFixture() {
  const cfg: OpenClawConfig = {
    gateway: { roles: { default: "visitor", definitions: structuredClone(roleDefinitions) } },
  };
  setRuntimeConfigSnapshot(cfg);
  const person = ensureProfileForEmail("visitor@example.test");
  const source = new AbortController();
  const request = new AbortController();
  const host: { current?: GatewayRequestContext } = {
    current: createGatewayRequestContext(makeContextParams()),
  };
  const params: RunParams = {
    ...systemRun,
    sessionKey: "agent:main:visitor-work",
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

const operatorTest = it.extend<{ fixture: ReturnType<typeof createOperatorRunFixture> }>({
  fixture: ({ task: _task }, use) =>
    withOpenClawTestState({ label: "compat-run" }, () => use(createOperatorRunFixture())),
});

function prepareRun(cfg: OpenClawConfig, operatorAuthority: CommandOptions["operatorAuthority"]) {
  const runId = "compat-admitted";
  return prepareAgentRunAdmission({
    cfg,
    facts: {
      runId,
      agentId: "main",
      ingress: { kind: "system", boundary: "compat-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    operatorAuthority,
  });
}

function disableUploads(cfg: OpenClawConfig) {
  setRuntimeConfigSnapshot({ ...cfg, gateway: { ...cfg.gateway, uploads: { enabled: false } } });
}

async function withPendingCommand(
  params: RunParams,
  run: (pending: {
    options: CommandOptions;
    authority: NonNullable<CommandOptions["operatorAuthority"]>;
    settlement: ReturnType<typeof createDeferred<typeof completedResult>>;
    running: ReturnType<typeof runOpenAiCompatibleAgentCommand>;
  }) => Promise<void>,
) {
  const entered = createDeferred<CommandOptions>();
  const settlement = createDeferred<typeof completedResult>();
  command.mockImplementation(async (options) => {
    entered.resolve(options);
    return await settlement.promise;
  });
  const running = runOpenAiCompatibleAgentCommand(params);
  try {
    const options = await Promise.race([
      entered.promise,
      running.then(() => {
        throw new Error("Command finished without receiving operator authority");
      }),
    ]);
    const authority = options.operatorAuthority;
    assert(authority, "Expected the original operator authority");
    await run({ options, authority, settlement, running });
  } finally {
    settlement.resolve(completedResult);
    await running.catch(() => {});
  }
}

beforeEach(() => {
  command.mockReset();
});

operatorTest.for([false, true])(
  "retains source authority through settlement and detached work (reject=%s)",
  async (reject, { fixture }) => {
    const failure = new Error("command failed");
    let child: ReturnType<typeof prepareAgentRunAdmission> | undefined;
    try {
      await withPendingCommand(fixture.params, async (pending) => {
        const { options, authority, settlement, running } = pending;
        expect(authority).toMatchObject({
          profileId: fixture.person.id,
          scopes: ["operator.sessions.write"],
        });
        expect(() => authority.assertCurrent()).not.toThrow();
        child = prepareRun(fixture.cfg, authority);
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
      });
    } finally {
      child?.close();
    }
  },
);

operatorTest.for(["grant", "role", "host", "committed config"] as const)(
  "rejects retained effects and late results after %s changes",
  async (changed, { fixture }) => {
    const context = fixture.host.current;
    assert(context, "Expected the current Gateway context");
    let tentative = fixture.cfg;
    let committed = fixture.cfg;
    if (changed === "committed config") {
      context.getRuntimeConfig = () => tentative;
      context.getCommittedRuntimeConfig = () => committed;
    }
    await withPendingCommand(fixture.params, async (pending) => {
      const { options, authority, settlement, running } = pending;
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
            roles: { default: "blocked", definitions: { blocked: roleDefinitions.blocked } },
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
    });
  },
);

operatorTest.for([
  { change: "missing host", message: /current Gateway context/ },
  { change: "closed host", message: /current Gateway context/ },
  { change: "ended grant", message: /Visitor access ended/ },
  { change: "uploads disabled", message: /uploads are disabled/ },
  { change: "request ended", message: /Request ended during preparation/ },
])("refuses command admission after $change", async ({ change, message }, { fixture }) => {
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
        disableUploads(fixture.cfg);
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

operatorTest(
  "preserves admitted input and output after uploads are disabled",
  async ({ fixture }) => {
    fixture.params.hasClientUploads = true;
    let admission: ReturnType<typeof prepareAgentRunAdmission> | undefined;
    command.mockImplementation(async (options) => {
      admission = prepareRun(fixture.cfg, options.operatorAuthority);
      await options.onAdmittedRunContext?.(await admission.admit("embedded"));
      disableUploads(fixture.cfg);
      options.assertSourceCurrent?.();
      return completedResult;
    });
    try {
      await expect(runOpenAiCompatibleAgentCommand(fixture.params)).resolves.toBe(completedResult);
    } finally {
      admission?.close();
    }
  },
);

operatorTest.for(["owner", "system"] as const)(
  "preserves %s authority without a person-bound Gateway capture",
  async (actor, { fixture }) => {
    fixture.params.resolveGatewayContext = undefined;
    fixture.params.senderIsOwner = true;
    fixture.params.requestAuth.operatorAccessAuthority = undefined;
    if (actor === "owner") {
      fixture.params.requestAuth.authenticatedUserProfile!.profileId = "gateway-owner";
    } else {
      fixture.params.requestAuth.operatorRoleActor = { kind: "system" };
    }
    command.mockImplementation(async (options) => {
      expect(options).toMatchObject({
        operatorAuthority: undefined,
        senderIsOwner: true,
      });
      expect(options.abortSignal).toBe(fixture.request.signal);
      return completedResult;
    });
    await expect(runOpenAiCompatibleAgentCommand(fixture.params)).resolves.toBe(completedResult);
  },
);

it.each([false, true])(
  "keeps authority until custody transfers (already admitted=%s)",
  async (alreadyAdmitted) => {
    const prepared = createDeferred();
    const proceed = createDeferred();
    const executed = vi.fn();
    const result = { ...completedResult, payloads: [{ text: "settled" }] };
    let current = true;
    command.mockImplementationOnce(async (opts) => {
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
      return result;
    });
    const pending = runOpenAiCompatibleAgentCommand({
      ...systemRun,
      hasCurrentClientAuthority: () => current,
    });
    await prepared.promise;
    current = false;
    proceed.resolve();
    if (alreadyAdmitted) {
      await expect(pending).resolves.toBe(result);
      expect(executed).toHaveBeenCalledOnce();
    } else {
      await expect(pending).rejects.toThrow("Gateway requester authority changed");
      expect(executed).not.toHaveBeenCalled();
    }
  },
);
const weatherCall = { id: "call_1", name: "get_weather", arguments: "{}" };
it.each([
  [undefined, undefined, undefined],
  [{ pendingToolCalls: "invalid" }, undefined, undefined],
  [
    {
      stopReason: "tool_calls",
      pendingToolCalls: [
        null,
        { id: 7, name: "ignored", arguments: "{}" },
        { id: " call_1 ", name: " get_weather ", arguments: { city: "Taipei" } },
      ],
    },
    "tool_calls",
    [{ id: "call_1", name: "get_weather", arguments: '{"city":"Taipei"}' }],
  ],
  [
    { stopReason: 42, pendingToolCalls: [weatherCall] },
    undefined,
    [{ id: "call_1", name: "get_weather", arguments: "{}" }],
  ],
] as const)(
  "normalizes terminal metadata, rejecting malformed calls: %o",
  (meta, stopReason, calls) => {
    expect(readOpenAiHttpRunTerminal({ meta })).toEqual({
      runFailed: false,
      stopReason,
      pendingToolCalls: calls,
    });
  },
);
it.each([
  ["a Gateway-cancelled run", () => AbortSignal.abort().reason, 500, "agent run was cancelled"],
  [
    "a provider transport timeout",
    () => new FailoverError("This operation was aborted", { reason: "timeout" }),
    504,
    "upstream provider timeout",
  ],
  [
    "an abort caused by a timeout",
    () =>
      createAbortError("This operation was aborted", {
        cause: new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      }),
    504,
    "upstream provider timeout",
  ],
] as const)("error envelope reports %s", (_name, error, status, message) => {
  expect(resolveOpenAiCompatibleAgentError(error())).toEqual({
    status,
    error: { message, type: "api_error" },
  });
});
