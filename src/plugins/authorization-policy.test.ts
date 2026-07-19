import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  hasAuthorizationPolicies,
  hasAuthorizationPoliciesForOperation,
  runAuthorizationPolicies,
  type AuthorizationPolicyDenial,
} from "./authorization-policy.js";
import type {
  AuthorizationInvocationContext,
  AuthorizationPolicyRegistration,
  AuthorizationToolCallRequest,
} from "./authorization-policy.types.js";
import type { PluginJsonValue } from "./host-hook-json.js";
import type { PluginAuthorizationPolicyRegistryRegistration } from "./registry-types.js";

const configMocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({})),
  getRuntimeConfigSnapshot: vi.fn(() => null),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: configMocks.getRuntimeConfig,
  getRuntimeConfigSnapshot: configMocks.getRuntimeConfigSnapshot,
}));

const senderContext: AuthorizationInvocationContext = {
  principal: {
    kind: "sender",
    provider: "discord",
    accountId: "default",
    senderId: "maintainer-1",
    roleIds: ["maintainers"],
  },
  conversationId: "maintenance",
  parentConversationId: "maintenance",
  threadId: "thread-1",
};

function requiredPolicyConfigWithScope(scope: {
  agentIds?: string[];
  providers?: string[];
  accountIds?: string[];
  conversationIds?: string[];
}): OpenClawConfig {
  return {
    plugins: {
      entries: {
        "molty-access": {
          authorization: {
            requiredPolicies: [
              {
                id: "sender-access",
                operations: ["tool.call"],
                scope,
              },
            ],
          },
        },
      },
    },
  };
}

const scopedRequiredPolicyConfig = requiredPolicyConfigWithScope({
  agentIds: ["molty"],
  providers: ["discord"],
  accountIds: ["molty"],
  conversationIds: ["maintenance"],
});

const scopedSenderPrincipal = {
  kind: "sender" as const,
  provider: "discord",
  accountId: "molty",
  senderId: "maintainer-1",
  roleIds: ["maintainers"],
};

const scopedSenderContext: AuthorizationInvocationContext = {
  principal: scopedSenderPrincipal,
  agentId: "molty",
  conversationId: "maintenance",
  parentConversationId: "maintenance",
  threadId: "thread-1",
};

const { agentId: _agentId, ...scopedContextWithoutAgent } = scopedSenderContext;
const { provider: _provider, ...scopedPrincipalWithoutProvider } = scopedSenderPrincipal;
const { accountId: _accountId, ...scopedPrincipalWithoutAccount } = scopedSenderPrincipal;
const {
  conversationId: _conversationId,
  parentConversationId: _parentConversationId,
  ...scopedContextWithoutConversation
} = scopedSenderContext;

const scopedProvenanceCases = [
  {
    dimension: "agent",
    missing: scopedContextWithoutAgent,
    nonmatching: { ...scopedSenderContext, agentId: "clawsweeper" },
  },
  {
    dimension: "provider",
    missing: { ...scopedSenderContext, principal: scopedPrincipalWithoutProvider },
    nonmatching: {
      ...scopedSenderContext,
      principal: { ...scopedSenderPrincipal, provider: "telegram" },
    },
  },
  {
    dimension: "account",
    missing: { ...scopedSenderContext, principal: scopedPrincipalWithoutAccount },
    nonmatching: {
      ...scopedSenderContext,
      principal: { ...scopedSenderPrincipal, accountId: "reef" },
    },
  },
  {
    dimension: "conversation",
    missing: scopedContextWithoutConversation,
    nonmatching: {
      ...scopedSenderContext,
      conversationId: "general",
      parentConversationId: "general",
    },
  },
] satisfies Array<{
  dimension: string;
  missing: AuthorizationInvocationContext;
  nonmatching: AuthorizationInvocationContext;
}>;

function registration(
  pluginId: string,
  policy: AuthorizationPolicyRegistration,
): PluginAuthorizationPolicyRegistryRegistration {
  return {
    pluginId,
    pluginName: pluginId,
    policy,
    origin: "workspace",
    source: `/plugins/${pluginId}/index.ts`,
  };
}

function registry(...policies: PluginAuthorizationPolicyRegistryRegistration[]) {
  return { authorizationPolicies: policies };
}

function toolRequest(
  input: Record<string, PluginJsonValue> = { action: "reply", target: "thread-1" },
): AuthorizationToolCallRequest {
  return {
    operation: "tool.call",
    toolName: "message",
    phase: "final",
    input,
  };
}

function expectDenial(
  denial: AuthorizationPolicyDenial | undefined,
  expected: Partial<AuthorizationPolicyDenial>,
) {
  expect(denial).toMatchObject({ denied: true, ...expected });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  configMocks.getRuntimeConfig.mockReset().mockReturnValue({});
  configMocks.getRuntimeConfigSnapshot.mockReset().mockReturnValue(null);
});

describe("authorization policy runner", () => {
  it("detects only policies that can affect the requested operation", () => {
    const toolOnly = registry(
      registration("tool-only", {
        id: "tool-only",
        description: "Tool calls only",
        handlers: { "tool.call": () => ({ effect: "pass" }) },
      }),
    );
    expect(
      hasAuthorizationPoliciesForOperation({
        operation: "tool.call",
        config: {},
        registry: toolOnly,
      }),
    ).toBe(true);
    expect(
      hasAuthorizationPoliciesForOperation({
        operation: "message.action",
        config: {},
        registry: toolOnly,
      }),
    ).toBe(false);
    expect(hasAuthorizationPolicies(toolOnly, {}, "tool.call")).toBe(true);
    expect(hasAuthorizationPolicies(toolOnly, {}, "message.action")).toBe(false);

    expect(
      hasAuthorizationPoliciesForOperation({
        operation: "message.action",
        config: {},
        registry: registry(
          registration("fail-closed", {
            id: "fail-closed",
            description: "Reject unhandled operations",
            unhandled: "deny",
            handlers: {},
          }),
        ),
      }),
    ).toBe(true);

    const requiredConfig = {
      plugins: {
        entries: {
          "message-policy": {
            authorization: {
              requiredPolicies: [{ id: "message-policy", operations: ["message.action" as const] }],
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    expect(
      hasAuthorizationPoliciesForOperation({
        operation: "message.action",
        config: requiredConfig,
        registry: registry(),
      }),
    ).toBe(true);
  });

  it("evaluates pass decisions in order without granting and stops at the first denial", async () => {
    const calls: string[] = [];
    const denial = await runAuthorizationPolicies({
      request: toolRequest(),
      context: senderContext,
      config: {},
      registry: registry(
        registration("first", {
          id: "first",
          description: "First policy",
          handlers: {
            "tool.call": () => {
              calls.push("first");
              return { effect: "pass" };
            },
          },
        }),
        registration("second", {
          id: "second",
          description: "Second policy",
          handlers: {
            "tool.call": () => {
              calls.push("second");
              return { effect: "deny", code: "unsafe-action" };
            },
          },
        }),
        registration("never", {
          id: "never",
          description: "Never reached",
          handlers: {
            "tool.call": () => {
              calls.push("never");
              return { effect: "pass" };
            },
          },
        }),
      ),
    });

    expect(calls).toEqual(["first", "second"]);
    expectDenial(denial, {
      kind: "deny",
      pluginId: "second",
      policyId: "second",
      code: "unsafe-action",
    });
    expect(denial).not.toHaveProperty("reason");
  });

  it("passes frozen snapshots while leaving the executable input untouched", async () => {
    const input = { action: "reply", nested: { target: "thread-1" } };
    let seenInput: unknown;
    const denial = await runAuthorizationPolicies({
      request: toolRequest(input),
      context: senderContext,
      config: {},
      registry: registry(
        registration("freeze", {
          id: "freeze",
          description: "Inspect immutable policy input",
          handlers: {
            "tool.call": (request, context) => {
              seenInput = request.input;
              expect(Object.isFrozen(request)).toBe(true);
              expect(Object.isFrozen(request.input)).toBe(true);
              expect(Object.isFrozen(request.input.nested)).toBe(true);
              expect(Object.isFrozen(context)).toBe(true);
              expect(Object.isFrozen(context.principal)).toBe(true);
              return { effect: "pass" };
            },
          },
        }),
      ),
    });

    expect(denial).toBeUndefined();
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.nested)).toBe(false);
    expect(input).not.toBe(seenInput);
    expect(input).toEqual(seenInput);
  });

  it("derives the tool action from canonical input instead of caller metadata", async () => {
    let seenAction: string | undefined;
    await runAuthorizationPolicies({
      request: { ...toolRequest({ action: "delete" }), action: "send" },
      context: senderContext,
      config: {},
      registry: registry(
        registration("action", {
          id: "action",
          description: "Inspect action",
          handlers: {
            "tool.call": (request) => {
              seenAction = request.action;
              return { effect: "pass" };
            },
          },
        }),
      ),
    });

    expect(seenAction).toBe("delete");
  });

  it("fails closed without invoking accessors or hiding non-JSON properties", async () => {
    const getter = vi.fn(() => "secret");
    const input: Record<string, PluginJsonValue> = { action: "reply" };
    Object.defineProperty(input, "hidden", { enumerable: true, get: getter });
    Object.defineProperty(input, Symbol("private"), { enumerable: true, value: "secret" });
    const handler = vi.fn(() => ({ effect: "pass" as const }));

    const denial = await runAuthorizationPolicies({
      request: toolRequest(input),
      context: senderContext,
      config: {},
      registry: registry(
        registration("strict-json", {
          id: "strict-json",
          description: "Reject hidden input",
          handlers: { "tool.call": handler },
        }),
      ),
    });

    expectDenial(denial, { code: "policy-input-invalid" });
    expect(getter).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ["an array", []],
    ["a string", "hidden"],
    ["null", null],
  ])("fails closed for %s as finalized tool input", async (_name, input) => {
    const handler = vi.fn(() => ({ effect: "pass" as const }));
    const denial = await runAuthorizationPolicies({
      request: { ...toolRequest(), input } as never,
      context: senderContext,
      config: {},
      registry: registry(
        registration("strict-tool-input", {
          id: "strict-tool-input",
          description: "Reject non-object tool input",
          handlers: { "tool.call": handler },
        }),
      ),
    });

    expectDenial(denial, { code: "policy-input-invalid" });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ["undefined", [undefined]],
    ["null", [null]],
  ])("fails closed for an %s policy registry entry", async (_name, policies) => {
    const denial = await runAuthorizationPolicies({
      request: toolRequest(),
      context: senderContext,
      config: {},
      registry: { authorizationPolicies: policies as never },
    });

    expectDenial(denial, { code: "policy-unreadable" });
  });

  it("fails closed for a sparse policy registry entry", async () => {
    const policies: PluginAuthorizationPolicyRegistryRegistration[] = [];
    policies.length = 1;

    const denial = await runAuthorizationPolicies({
      request: toolRequest(),
      context: senderContext,
      config: {},
      registry: { authorizationPolicies: policies },
    });

    expectDenial(denial, { code: "policy-unreadable" });
  });

  it("fails closed without invoking an accessor-backed policy registry entry", async () => {
    const getter = vi.fn(() =>
      registration("hidden", {
        id: "hidden",
        description: "Hidden policy",
        handlers: { "tool.call": () => ({ effect: "pass" }) },
      }),
    );
    const policies: PluginAuthorizationPolicyRegistryRegistration[] = [];
    Object.defineProperty(policies, "0", { enumerable: true, get: getter });
    policies.length = 1;

    const denial = await runAuthorizationPolicies({
      request: toolRequest(),
      context: senderContext,
      config: {},
      registry: { authorizationPolicies: policies },
    });

    expectDenial(denial, { code: "policy-unreadable" });
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "throws",
      handler: () => {
        throw new Error("private detail");
      },
      code: "policy-evaluation-failed",
    },
    {
      name: "returns a former allow decision",
      handler: () => ({ effect: "allow" }) as never,
      code: "policy-decision-invalid",
    },
    {
      name: "returns policy-authored prose",
      handler: () => ({ effect: "deny", code: "blocked", reason: "private" }) as never,
      code: "policy-decision-invalid",
    },
  ])("fails closed when a policy $name", async ({ handler, code }) => {
    const denial = await runAuthorizationPolicies({
      request: toolRequest(),
      context: senderContext,
      config: {},
      registry: registry(
        registration("broken", {
          id: "broken",
          description: "Broken policy",
          handlers: { "tool.call": handler },
        }),
      ),
    });

    expectDenial(denial, { kind: "error", policyId: "broken", code });
  });

  it("fails closed when a policy times out", async () => {
    const denial = await runAuthorizationPolicies({
      request: toolRequest(),
      context: senderContext,
      config: {},
      registry: registry(
        registration("slow", {
          id: "slow",
          description: "Slow policy",
          timeoutMs: 1,
          handlers: { "tool.call": async () => await new Promise(() => {}) },
        }),
      ),
    });

    expectDenial(denial, {
      kind: "error",
      policyId: "slow",
      code: "policy-evaluation-timed-out",
    });
  });

  it("fails closed when a synchronous policy returns after its deadline", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const denial = await runAuthorizationPolicies({
      request: toolRequest(),
      context: senderContext,
      config: {},
      registry: registry(
        registration("slow-sync", {
          id: "slow-sync",
          description: "Returns after its budget",
          timeoutMs: 1,
          handlers: {
            "tool.call": () => {
              now = 2;
              return { effect: "pass" };
            },
          },
        }),
      ),
    });

    expectDenial(denial, {
      kind: "error",
      policyId: "slow-sync",
      code: "policy-evaluation-timed-out",
    });
  });

  it("applies a monotonic total deadline across synchronous policies", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(Date, "now").mockReturnValueOnce(10_000).mockReturnValue(-10_000);
    const denial = await runAuthorizationPolicies({
      request: toolRequest(),
      context: senderContext,
      config: {},
      registry: registry(
        registration("first", {
          id: "first",
          description: "Consumes the chain budget",
          timeoutMs: 30_000,
          handlers: {
            "tool.call": () => {
              now = 29_999;
              return { effect: "pass" };
            },
          },
        }),
        registration("second", {
          id: "second",
          description: "Crosses the chain budget",
          timeoutMs: 30_000,
          handlers: {
            "tool.call": () => {
              now = 30_001;
              return { effect: "pass" };
            },
          },
        }),
      ),
    });

    expect(denial).toMatchObject({
      kind: "error",
      policyId: "second",
      code: "policy-chain-timed-out",
    });
  });

  it("rejects accessor-backed decisions without invoking their getters", async () => {
    const effectGetter = vi.fn(() => "deny");
    const codeGetter = vi.fn(() => "safe-code");
    const decision = Object.defineProperties(
      {},
      {
        effect: { enumerable: true, get: effectGetter },
        code: { enumerable: true, get: codeGetter },
      },
    );

    const denial = await runAuthorizationPolicies({
      request: toolRequest(),
      context: senderContext,
      config: {},
      registry: registry(
        registration("accessor", {
          id: "accessor",
          description: "Returns accessors",
          handlers: { "tool.call": () => decision as never },
        }),
      ),
    });

    expectDenial(denial, { code: "policy-decision-invalid" });
    expect(effectGetter).not.toHaveBeenCalled();
    expect(codeGetter).not.toHaveBeenCalled();
  });

  it("includes decision parsing in the policy deadline", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const decision = new Proxy(
      { effect: "pass" as const },
      {
        getOwnPropertyDescriptor: (target, property) => {
          now = 2;
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      },
    );

    const denial = await runAuthorizationPolicies({
      request: toolRequest(),
      context: senderContext,
      config: {},
      registry: registry(
        registration("slow-decision", {
          id: "slow-decision",
          description: "Returns a slow decision",
          timeoutMs: 1,
          handlers: { "tool.call": () => decision },
        }),
      ),
    });

    expectDenial(denial, {
      policyId: "slow-decision",
      code: "policy-evaluation-timed-out",
    });
  });

  it("accepts frozen plain data decisions", async () => {
    const denial = await runAuthorizationPolicies({
      request: toolRequest(),
      context: senderContext,
      config: {},
      registry: registry(
        registration("frozen", {
          id: "frozen",
          description: "Returns frozen data",
          handlers: {
            "tool.call": () => Object.freeze({ effect: "deny" as const, code: "frozen-deny" }),
          },
        }),
      ),
    });

    expectDenial(denial, { kind: "deny", code: "frozen-deny" });
  });

  it("scopes required policies to configured operations", async () => {
    const config = {
      plugins: {
        entries: {
          "molty-access": {
            authorization: {
              requiredPolicies: [{ id: "sender-access", operations: ["command.invoke" as const] }],
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    await expect(
      runAuthorizationPolicies({
        request: toolRequest(),
        context: senderContext,
        config,
        registry: registry(),
      }),
    ).resolves.toBeUndefined();
    const denial = await runAuthorizationPolicies({
      request: {
        operation: "command.invoke",
        phase: "final",
        commandName: "fix",
        owner: { kind: "core" },
        source: "text",
      },
      context: senderContext,
      config,
      registry: registry(),
    });
    expectDenial(denial, {
      pluginId: "molty-access",
      policyId: "sender-access",
      code: "required-policy-missing",
    });
  });

  it("scopes fail-closed required policies to matching invocation context", async () => {
    await expect(
      runAuthorizationPolicies({
        request: toolRequest(),
        context: scopedSenderContext,
        config: scopedRequiredPolicyConfig,
        registry: registry(),
      }),
    ).resolves.toMatchObject({ code: "required-policy-missing" });
    await expect(
      runAuthorizationPolicies({
        request: toolRequest(),
        context: {
          ...scopedSenderContext,
          conversationId: "thread-1",
          parentConversationId: "maintenance",
        },
        config: scopedRequiredPolicyConfig,
        registry: registry(),
      }),
    ).resolves.toMatchObject({ code: "required-policy-missing" });
  });

  it.each(scopedProvenanceCases)(
    "keeps the required pin active for missing $dimension provenance but skips a known nonmatch",
    async ({ missing, nonmatching }) => {
      await expect(
        runAuthorizationPolicies({
          request: toolRequest(),
          context: missing,
          config: scopedRequiredPolicyConfig,
          registry: registry(),
        }),
      ).resolves.toMatchObject({ code: "required-policy-missing" });
      await expect(
        runAuthorizationPolicies({
          request: toolRequest(),
          context: nonmatching,
          config: scopedRequiredPolicyConfig,
          registry: registry(),
        }),
      ).resolves.toBeUndefined();
    },
  );

  it.each([
    {
      dimension: "agent",
      context: { ...scopedSenderContext, agentId: "   " },
      scope: { agentIds: ["molty"] },
    },
    {
      dimension: "provider",
      context: {
        ...scopedSenderContext,
        principal: { ...scopedSenderPrincipal, provider: "" },
      },
      scope: { providers: ["discord"] },
    },
    {
      dimension: "account",
      context: {
        ...scopedSenderContext,
        principal: { ...scopedSenderPrincipal, accountId: "   " },
      },
      scope: { accountIds: ["molty"] },
    },
    {
      dimension: "conversation",
      context: {
        ...scopedSenderContext,
        conversationId: "",
        parentConversationId: "   ",
      },
      scope: { conversationIds: ["maintenance"] },
    },
  ] satisfies Array<{
    dimension: string;
    context: AuthorizationInvocationContext;
    scope: Parameters<typeof requiredPolicyConfigWithScope>[0];
  }>)("keeps a required pin active for blank $dimension provenance", async ({ context, scope }) => {
    await expect(
      runAuthorizationPolicies({
        request: toolRequest(),
        context,
        config: requiredPolicyConfigWithScope(scope),
        registry: registry(),
      }),
    ).resolves.toMatchObject({ code: "required-policy-missing" });
  });

  it("validates scoped provenance before using it to skip a required pin", async () => {
    const providerGetter = vi.fn(() => "telegram");
    const principal = { ...scopedSenderPrincipal };
    Object.defineProperty(principal, "provider", {
      enumerable: true,
      get: providerGetter,
    });

    await expect(
      runAuthorizationPolicies({
        request: toolRequest(),
        context: { ...scopedSenderContext, principal },
        config: requiredPolicyConfigWithScope({ providers: ["discord"] }),
        registry: registry(),
      }),
    ).resolves.toMatchObject({
      pluginId: "molty-access",
      policyId: "sender-access",
      code: "policy-input-invalid",
    });
    expect(providerGetter).not.toHaveBeenCalled();
  });

  it("rejects proxied scoped provenance without invoking proxy traps", async () => {
    const getOwnPropertyDescriptor = vi.fn(
      (target: AuthorizationInvocationContext, property: PropertyKey) =>
        Reflect.getOwnPropertyDescriptor(target, property),
    );
    const context: AuthorizationInvocationContext = new Proxy(scopedSenderContext, {
      getOwnPropertyDescriptor,
    });

    await expect(
      runAuthorizationPolicies({
        request: toolRequest(),
        context,
        config: scopedRequiredPolicyConfig,
        registry: registry(),
      }),
    ).resolves.toMatchObject({ code: "policy-input-invalid" });
    expect(getOwnPropertyDescriptor).not.toHaveBeenCalled();
  });

  it.each([
    {
      dimension: "provider",
      principal: { kind: "unknown" as const, accountId: "molty" },
      scope: { providers: ["discord"] },
    },
    {
      dimension: "account",
      principal: { kind: "unknown" as const, provider: "discord" },
      scope: { accountIds: ["molty"] },
    },
  ])("keeps a required pin active for unknown principal missing $dimension", async (entry) => {
    await expect(
      runAuthorizationPolicies({
        request: toolRequest(),
        context: { principal: entry.principal },
        config: requiredPolicyConfigWithScope(entry.scope),
        registry: registry(),
      }),
    ).resolves.toMatchObject({ code: "required-policy-missing" });
  });

  it.each([
    {
      principalKind: "operator",
      principal: { kind: "operator" as const, scopes: ["operator.read"] },
    },
    {
      principalKind: "service",
      principal: { kind: "service" as const, serviceId: "cron" },
    },
  ])(
    "treats an authenticated $principalKind principal as outside provider/account scopes",
    async ({ principal }) => {
      for (const scope of [{ providers: ["discord"] }, { accountIds: ["molty"] }]) {
        await expect(
          runAuthorizationPolicies({
            request: toolRequest(),
            context: { principal },
            config: requiredPolicyConfigWithScope(scope),
            registry: registry(),
          }),
        ).resolves.toBeUndefined();
      }
    },
  );

  it.each([
    { principalKind: "operator without scopes", principal: { kind: "operator" } },
    {
      principalKind: "operator with malformed scopes",
      principal: { kind: "operator", scopes: ["   "] },
    },
    { principalKind: "service without identity", principal: { kind: "service", serviceId: "" } },
    { principalKind: "unrecognized", principal: { kind: "external" } },
  ])(
    "keeps a required pin active for malformed $principalKind provenance",
    async ({ principal }) => {
      await expect(
        runAuthorizationPolicies({
          request: toolRequest(),
          context: { principal } as never,
          config: requiredPolicyConfigWithScope({ providers: ["discord"] }),
          registry: registry(),
        }),
      ).resolves.toMatchObject({ code: "required-policy-missing" });
    },
  );

  it("loads required policies from runtime config when no policy registered yet", async () => {
    const config = {
      plugins: {
        entries: {
          "molty-access": {
            authorization: {
              requiredPolicies: [{ id: "sender-access", operations: ["command.invoke" as const] }],
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    configMocks.getRuntimeConfig.mockReturnValue(config);
    const request = {
      operation: "command.invoke" as const,
      phase: "final" as const,
      commandName: "fix",
      owner: { kind: "core" as const },
      source: "text" as const,
    };

    expect(hasAuthorizationPolicies(registry())).toBe(true);
    await expect(
      runAuthorizationPolicies({ request, context: senderContext, registry: registry() }),
    ).resolves.toMatchObject({
      pluginId: "molty-access",
      policyId: "sender-access",
      code: "required-policy-missing",
    });
    expect(configMocks.getRuntimeConfig).toHaveBeenCalledWith({ skipPluginValidation: true });
  });

  it("treats an unavailable runtime config as an active fail-closed engine", async () => {
    configMocks.getRuntimeConfig.mockImplementation(() => {
      throw new Error("unavailable");
    });

    expect(hasAuthorizationPolicies(registry())).toBe(true);
    await expect(
      runAuthorizationPolicies({
        request: toolRequest(),
        context: senderContext,
        registry: registry(),
      }),
    ).resolves.toMatchObject({ code: "policy-config-unavailable" });
  });

  it("requires the configured plugin to register a handler for each required operation", async () => {
    const config = {
      plugins: {
        entries: {
          " MOLTY-ACCESS ": {
            authorization: {
              requiredPolicies: [{ id: "sender-access", operations: ["command.invoke" as const] }],
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    const policy: AuthorizationPolicyRegistration = {
      id: "sender-access",
      description: "Sender access",
      handlers: { "tool.call": () => ({ effect: "pass" }) },
    };

    const denial = await runAuthorizationPolicies({
      request: {
        operation: "command.invoke",
        phase: "final",
        commandName: "fix",
        owner: { kind: "core" },
        source: "text",
      },
      context: senderContext,
      config,
      registry: registry(registration("molty-access", policy)),
    });
    expectDenial(denial, { code: "required-policy-handler-missing" });
  });

  it("accepts a required policy only from the configured plugin", async () => {
    const config = {
      plugins: {
        entries: {
          "molty-access": {
            authorization: {
              requiredPolicies: [{ id: "sender-access", operations: ["command.invoke" as const] }],
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    const policy: AuthorizationPolicyRegistration = {
      id: "sender-access",
      description: "Sender access",
      handlers: { "command.invoke": () => ({ effect: "pass" }) },
    };
    const request = {
      operation: "command.invoke" as const,
      phase: "final" as const,
      commandName: "fix",
      owner: { kind: "core" as const },
      source: "text" as const,
    };

    await expect(
      runAuthorizationPolicies({
        request,
        context: senderContext,
        config,
        registry: registry(registration("other-plugin", policy)),
      }),
    ).resolves.toMatchObject({ code: "required-policy-missing" });
    await expect(
      runAuthorizationPolicies({
        request,
        context: senderContext,
        config,
        registry: registry(registration("molty-access", policy)),
      }),
    ).resolves.toBeUndefined();
  });

  it("fails closed on caller abort without invoking a policy", async () => {
    const handler = vi.fn(() => ({ effect: "pass" as const }));
    const controller = new AbortController();
    controller.abort();
    const denial = await runAuthorizationPolicies({
      request: toolRequest(),
      context: senderContext,
      config: {},
      signal: controller.signal,
      registry: registry(
        registration("abort", {
          id: "abort",
          description: "Abort policy",
          handlers: { "tool.call": handler },
        }),
      ),
    });

    expectDenial(denial, { kind: "abort", code: "policy-evaluation-aborted" });
    expect(handler).not.toHaveBeenCalled();
  });
});
