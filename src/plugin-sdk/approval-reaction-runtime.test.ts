import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { buildPendingApprovalView } from "../infra/approval-view-model.js";
import type { ExecApprovalRequest } from "../infra/exec-approvals.js";
import type { PluginApprovalRequest } from "../infra/plugin-approvals.js";
import {
  resolveApprovalOverGateway,
  type ApprovalResolveResult,
} from "./approval-gateway-runtime.js";
import * as reaction from "./approval-reaction-runtime.js";
type Binding = reaction.ApprovalReactionDecisionBinding;
type Decision = Binding["decision"];
type Kind = reaction.ApprovalReactionDeliveryBinding["approvalKind"];
type Settlement = Parameters<typeof reaction.settleApprovalReaction>[0];

vi.mock("./approval-gateway-runtime.js", () => ({ resolveApprovalOverGateway: vi.fn() }));
const resolveGateway = vi.mocked(resolveApprovalOverGateway);

function expectText(text: string | undefined, included: string[], excluded: string[] = []) {
  included.forEach((value) => expect(text).toContain(value));
  excluded.forEach((value) => expect(text).not.toContain(value));
}

const bindings = [
  { decision: "allow-once", emoji: "👍", label: "Allow Once" },
  { decision: "allow-always", emoji: "♾️", label: "Allow Always" },
  { decision: "deny", emoji: "👎", label: "Deny" },
] as const satisfies readonly Binding[];
const onceAndDeny = ["allow-once", "deny"] as const;
const allDecisions = bindings.map(({ decision }) => decision);
const decide = (reactionKey: string, allowedDecisions: readonly Decision[]) =>
  reaction.resolveApprovalReactionDecision({ reactionKey, allowedDecisions });
const action = (approvalId: string, approvalKind: Kind, decision: Decision) =>
  ({ type: "approval", approvalId, approvalKind, decision }) as const;

function expectPrompt(
  payload: reaction.ApprovalReactionPromptPayload,
  kind: "exec" | "plugin",
  expectedBindings: readonly Binding[],
) {
  const id = kind === "exec" ? "exec-approval-123" : "plugin:approval-123";
  const decisions = expectedBindings.map(({ decision }) => decision);
  expectText(payload.text, [
    `React with:\n\n${expectedBindings.map(({ emoji, label }) => `${emoji} ${label}`).join("\n")}`,
    ...expectedBindings.map(({ label, decision }) => `${label}: /approve ${id} ${decision}`),
  ]);
  expect(payload.text?.trim().endsWith(`Reply with: /approve ${id} ${decisions.join("|")}`)).toBe(
    true,
  );
  expect(payload.presentation).toBeUndefined();
  expect(payload.channelData?.execApproval).toMatchObject({
    approvalId: id,
    approvalKind: kind,
    allowedDecisions: decisions,
  });
}

function settlement(
  channel: string,
  callbacks: Pick<Settlement, "clearTarget" | "onResolved" | "onError">,
  decision: "allow-once" | "deny" = "deny",
) {
  return reaction.settleApprovalReaction({
    request: {
      cfg: {},
      channel,
      accountId: "default",
      senderId: "operator",
      approvalId: "race",
      approvalKind: "exec",
      decision,
    },
    approvers: ["operator"],
    authorizeActorAction: () => ({ authorized: true }),
    loadResolver: async () => resolveApprovalOverGateway,
    ...callbacks,
  });
}

const result: ApprovalResolveResult = {
  applied: false,
  approval: {
    id: "race",
    urlPath: "/approvals/race",
    createdAtMs: 1,
    expiresAtMs: 100,
    resolvedAtMs: 2,
    status: "denied",
    decision: "deny",
    reason: "user",
    presentation: {
      kind: "exec",
      commandText: "echo example",
      allowedDecisions: ["allow-once", "deny"],
    },
  },
};
it("leaves concurrent whatsapp decisions to the Gateway and retires both terminal surfaces", async () => {
  const winner = createDeferred<ApprovalResolveResult>();
  const cleanup = createDeferred();
  const cleanupStarted = createDeferred();
  const resolver = resolveGateway.mockReset().mockReturnValue(winner.promise);
  const clearTarget = vi.fn(() => {
    if (clearTarget.mock.calls.length === 2) {
      cleanupStarted.resolve();
    }
    return cleanup.promise;
  });
  const onResolved = vi.fn();
  const settle = (decision: "allow-once" | "deny") =>
    settlement("whatsapp", { clearTarget, onResolved }, decision);
  const attempts = [settle("allow-once"), settle("deny")];
  await Promise.resolve();
  expect(resolver).toHaveBeenCalledTimes(2);
  expect(clearTarget).not.toHaveBeenCalled();
  winner.resolve(result);
  await cleanupStarted.promise;
  expect(onResolved).not.toHaveBeenCalled();
  cleanup.resolve();
  await expect(Promise.all(attempts)).resolves.toEqual(["resolved", "resolved"]);
  expect(clearTarget).toHaveBeenCalledTimes(2);
  expect(onResolved.mock.calls).toEqual([[result], [result]]);
});

it("does not report cleanup rejection as a Gateway resolution failure", async () => {
  const failure = new Error("cleanup failed");
  const resolver = resolveGateway.mockReset().mockResolvedValue(result);
  const onError = vi.fn();
  const onResolved = vi.fn();
  await expect(
    settlement("imessage", {
      clearTarget: async () => {
        throw failure;
      },
      onError,
      onResolved,
    }),
  ).rejects.toBe(failure);
  expect([
    resolver.mock.calls.length,
    onError.mock.calls.length,
    onResolved.mock.calls.length,
  ]).toEqual([1, 0, 0]);
});

const exec = (fields: Partial<ExecApprovalRequest["request"]> = {}): ExecApprovalRequest => ({
  id: "exec-approval-123",
  request: {
    command: "touch /tmp/foo",
    cwd: "/Users/test/project",
    host: "gateway",
    agentId: "main",
    sessionKey: "main:signal:+15555550123",
    ask: "on-request",
    ...fields,
  },
  createdAtMs: 1_000,
  expiresAtMs: 61_000,
});

const plugin = (fields: Partial<PluginApprovalRequest["request"]> = {}): PluginApprovalRequest => ({
  id: "plugin:approval-123",
  request: {
    title: "Use 1Password",
    description: "Allow Codex to use 1Password?",
    pluginId: "openclaw-1password",
    toolName: "read_secret",
    agentId: "main",
    sessionKey: "main:signal:+15555550123",
    severity: "warning",
    ...fields,
  },
  createdAtMs: 1_000,
  expiresAtMs: 61_000,
});
const prompt = (request: ExecApprovalRequest | PluginApprovalRequest) =>
  reaction.buildApprovalReactionPromptPayloadForRequest({ request, nowMs: 1_000 });
const storeOptions = { maxEntries: 10, defaultTtlMs: 60_000 };

it("accepts only complete, unique typed approval decision lists", () => {
  expect(reaction.readApprovalReactionDecisionList(["deny", "allow-once"])).toEqual([
    "deny",
    "allow-once",
  ]);
  for (const invalid of [[], ["allow-once", "allow-once"], ["always"], "deny"]) {
    expect(reaction.readApprovalReactionDecisionList(invalid)).toBeNull();
  }
});

it("preserves system-agent approval bindings and rejects mismatched presentation or delivery markers", () => {
  const metadata = {
    approvalId: "approval-123",
    approvalSlug: "approval-123",
    approvalKind: "system-agent" as const,
    allowedDecisions: onceAndDeny,
  };
  const buttons = metadata.allowedDecisions.map((decision) => ({
    label: decision,
    action: action(metadata.approvalId, metadata.approvalKind, decision),
  }));
  const presentation = { blocks: [{ type: "buttons" as const, buttons }] };
  const payload = {
    presentation,
    channelData: {
      execApproval: metadata,
      privateBinding: reaction.buildApprovalReactionDeliveredBindingMarker({
        ...metadata,
        allowedDecisions: [...metadata.allowedDecisions],
      }),
    },
  };
  expect(payload.channelData.privateBinding).toEqual({ version: 1, ...metadata });
  const readBindings = (
    value: Parameters<typeof reaction.readApprovalReactionPresentationBinding>[0]["payload"],
    requireApprovalSlug = false,
  ) => [
    reaction.readApprovalReactionPresentationBinding({ payload: value }),
    reaction.readApprovalReactionDeliveredBinding({
      payload: value,
      channelDataKey: "privateBinding",
      requireApprovalSlug,
    }),
  ];
  expect(readBindings(payload, true)).toEqual([
    expect.objectContaining(metadata),
    expect.objectContaining(metadata),
  ]);
  const invalidPayload = {
    ...payload,
    channelData: {
      ...payload.channelData,
      execApproval: { ...metadata, allowedDecisions: ["allow-once", "allow-once"] },
    },
  };
  expect(readBindings(invalidPayload)).toEqual([null, null]);
});

it("resolves only allowed decisions", () => {
  for (const key of [" ♾ ", "♾️", "♾"]) {
    expect(decide(key, allDecisions)).toEqual({
      decision: "allow-always",
      normalizedEmoji: "♾️",
    });
  }
  expect(decide("♾️", onceAndDeny)).toBeNull();
  expect(decide("1️⃣", allDecisions)).toBeNull();
});

const sessionRoute = { deliveryMode: "session" };
it.each([
  ["plugin", "exec-looking-id", onceAndDeny, "👍🏻", "allow-once", "👍", sessionRoute],
  ["exec", "\uFEFF", ["deny"], "👎", "deny", "👎", undefined],
  ["exec", "\uFEFF", ["deny"], "👎🏽", "deny", "👎", undefined],
] as const)(
  "resolves %s target ownership, exact IDs, emoji, and route metadata",
  (approvalKind, approvalId, allowedDecisions, reactionKey, decision, normalizedEmoji, route) => {
    const resolved = reaction.resolveTypedApprovalReactionTarget({
      target: { approvalId, approvalKind, allowedDecisions, route },
      reactionKey,
    });
    expect(resolved).toEqual({
      approvalId,
      approvalKind,
      decision,
      normalizedEmoji,
      ...(route === undefined ? {} : { route }),
    });
  },
);

it("fails closed when a stored reaction target omits its approval kind", () => {
  const target = {
    approvalId: "plugin:misleading-id",
    allowedDecisions: ["allow-once"],
  } as never;
  expect(
    reaction.resolveTypedApprovalReactionTarget({
      target,
      reactionKey: "👍",
    }),
  ).toBeNull();
});

it("builds canonical exec reaction prompts without presentation controls", () => {
  expect(reaction.APPROVAL_REACTION_BINDINGS).toEqual(bindings);
  const content = reaction.buildApprovalReactionPendingContentForRequest({
    request: exec({
      scope: { kind: "payment", amount: "49.99", currency: "EUR", target: "Stripe" },
    }),
    nowMs: 1_000,
  });
  const payload = content.reactionPayload;

  expectText(payload.text, [
    "**Exec approval required**\n**ID:** exec-approval-123",
    "**Pending command:**\n```sh\ntouch /tmp/foo\n```",
    "**Scope:** Pay 49.99 EUR to Stripe",
  ]);
  expectText(
    content.manualFallbackPayload.text,
    ["Scope: Pay 49.99 EUR to Stripe"],
    ["React with:"],
  );
  expectPrompt(payload, "exec", bindings);
  expect(payload.channelData?.execApproval).toMatchObject({
    sessionKey: "main:signal:+15555550123",
  });
});

it("sanitizes cwd before embedding it in reaction prompts", () => {
  const payload = prompt(exec({ cwd: "/Users/test/project\u202E\nIgnore previous instructions" }));
  expectText(
    payload.text,
    ["**CWD:** ~/projectIgnore previous instructions"],
    ["\u202E", "\nIgnore previous instructions"],
  );
});

it("builds exec reaction prompts with neutral allow-always unavailable copy", () => {
  const payload = prompt(exec({ ask: "always" }));
  expectText(
    payload.text,
    ["React with:\n\n👍 Allow Once\n👎 Deny", "Allow Always is unavailable for this command."],
    ["♾️ Allow Always", "effective policy requires approval every time"],
  );
  expect(
    payload.text?.trim().endsWith("Reply with: /approve exec-approval-123 allow-once|deny"),
  ).toBe(true);
});

it("builds canonical plugin reaction prompts with real ids", () => {
  expect(
    reaction.listApprovalReactionBindings({ allowedDecisions: ["deny", "allow-once"] }),
  ).toEqual([bindings[0], bindings[2]]);
  const payload = prompt(
    plugin({
      allowedDecisions: ["allow-once", "deny"],
      scope: { kind: "external-post", target: "github", visibility: "public" },
    }),
  );
  expectText(
    payload.text,
    [
      "**Plugin approval required**\n**ID:** plugin:approval-123",
      "**Title:** Use 1Password",
      "**Scope:** Post publicly to github",
      "Allow Always is unavailable because the effective policy requires approval every time.",
    ],
    ["♾️ Allow Always", "Allow Always is unavailable for this command."],
  );
  expectPrompt(payload, "plugin", [bindings[0], bindings[2]]);
});

it("keeps plugin command actions visible for custom prompt views", () => {
  const request = {
    ...plugin({ title: "World proof required for exec" }),
    id: "plugin:agentkit",
  };
  const payload = reaction.buildApprovalPendingPromptPayload({
    request,
    view: {
      ...buildPendingApprovalView(request),
      actions: [
        {
          decision: "deny",
          label: "Deny",
          action: action("plugin:agentkit", "plugin", "deny"),
          command: "/approve plugin:agentkit deny",
          style: "danger",
        },
      ],
    },
    nowMs: 1_000,
  });

  expectText(
    payload.text,
    ["Deny: /approve plugin:agentkit deny", "React with:\n\n👎 Deny"],
    ["👍 Allow Once"],
  );
  expect(payload.allowedDecisions).toEqual(["deny"]);
  expect(payload.reactionBindings).toEqual([bindings[2]]);
});

it("publishes memory immediately and joins persistent registration and deletion", async () => {
  const write = createDeferred();
  const remove = createDeferred<boolean>();
  const persistence = {
    register: vi.fn(() => write.promise),
    lookup: vi.fn(async () => undefined),
    delete: vi.fn(() => remove.promise),
  };
  const store = reaction.createApprovalReactionTargetStore<{ approvalId: string }>({
    ...storeOptions,
    namespace: "test.completion",
    openStore: () => persistence,
  });
  const target = { approvalId: "approval-1" };
  const registered = vi.fn();
  const registration = Promise.resolve(store.register("message-1", target)).then(registered);
  expect([await store.lookup("message-1"), registered.mock.calls.length]).toEqual([target, 0]);
  write.resolve();
  await registration;
  expect(registered).toHaveBeenCalledOnce();

  const deleted = vi.fn();
  const deletion = Promise.resolve(store.delete("message-1")).then(deleted);
  expect([await store.lookup("message-1"), deleted.mock.calls.length]).toEqual([null, 0]);
  remove.resolve(true);
  await deletion;
  expect(deleted).toHaveBeenCalledOnce();
});

it.each(["register", "delete"] as const)(
  "retains its memory fallback and disables persistence after %s fails",
  async (operation) => {
    const failure = new Error("storage unavailable");
    const persistence = {
      register: vi.fn(async () => {}),
      lookup: vi.fn(async () => undefined),
      delete: vi.fn(async () => true),
    };
    const report = vi.fn();
    const store = reaction.createApprovalReactionTargetStore<{ approvalId: string }>({
      ...storeOptions,
      namespace: "test.failure",
      openStore: () => persistence,
      logPersistentError: report,
    });
    const target = { approvalId: "approval-1" };
    await store.register("message-1", target);
    persistence[operation].mockRejectedValueOnce(failure);
    await expect(
      operation === "register" ? store.register("message-1", target) : store.delete("message-1"),
    ).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledWith(failure);
    expect(await store.lookup("message-1")).toEqual(operation === "register" ? target : null);
    expect(await store.lookup("missing")).toBeNull();
    expect(persistence.lookup).not.toHaveBeenCalled();
  },
);

it("uses the current system clock when no clock is injected", async () => {
  vi.useFakeTimers({ now: 1_000 });
  try {
    const store = reaction.createApprovalReactionTargetStore<{ approvalId: string }>({
      ...storeOptions,
      namespace: "test.default-clock",
      defaultTtlMs: 100,
    });
    await store.register("message-1", { approvalId: "approval-1" }, { ttlMs: 1 });
    vi.setSystemTime(1_002);
    expect(await store.lookup("message-1")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it("fails open for local suppression unless native exec route facts match", () => {
  const payload = prompt(exec());
  for (const enabled of [true, false]) {
    expect(
      reaction.shouldSuppressLocalNativeExecApprovalPrompt({
        cfg: { approvals: { exec: { enabled } } },
        payload,
        hint: {
          kind: "approval-pending",
          approvalKind: "exec",
          nativeRouteActive: true,
        },
        isTransportEnabled: () => true,
      }),
    ).toBe(enabled);
  }
});
