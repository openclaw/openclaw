import { assert, beforeEach, expect, it, vi } from "vitest";
import type { DecisionReceiptV1 } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { AdmittedRunContext } from "../../agents/admitted-run-context.js";
import { configureRuntimeActionDecisionSink } from "../../audit/runtime-action-decision.js";
import { setReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  assertMemoryAudienceCurrent,
  assertMemoryAudienceSession,
  resolveMemoryAudienceFromEntry,
} from "../memory-audience.js";
import { fakeSessionOwner } from "../memory-audience.test-support.js";
import { withPluginRuntimePluginScope } from "./gateway-request-scope.js";
import type { PluginRuntime } from "./types.js";

const mocks = vi.hoisted(() => ({
  authorityActive: true,
  close: vi.fn(),
  createOperationalRunInstanceRef: vi.fn((runId: string) => ({
    instanceId: `instance:${runId}`,
    runId,
  })),
  getRuntimeConfig: vi.fn(() => ({}) as OpenClawConfig),
  prepareAgentRunAdmission: vi.fn(),
  runEmbeddedAgentCore: vi.fn(),
}));

vi.mock("../../agents/admitted-run-context.js", () => ({
  createOperationalRunInstanceRef: mocks.createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority: vi.fn(() =>
    mocks.authorityActive ? { runId: "run-plugin" } : undefined,
  ),
  prepareAgentRunAdmission: mocks.prepareAgentRunAdmission,
}));
vi.mock("../../agents/embedded-agent.js", () => ({
  runEmbeddedAgent: mocks.runEmbeddedAgentCore,
}));
vi.mock("../../config/config.js", () => ({ getRuntimeConfig: mocks.getRuntimeConfig }));
vi.mock("../../config/sessions/session-delivery-generation.js", async () => {
  const { fakeSessionGenerationModule } = await import("../memory-audience.test-support.js");
  return fakeSessionGenerationModule;
});
vi.mock("../../config/sessions/session-entry-read-runtime.js", async () => {
  const { fakeSessionEntryReadModule } = await import("../memory-audience.test-support.js");
  return fakeSessionEntryReadModule;
});

import { runPluginEmbeddedAgent } from "./runtime-embedded-agent.runtime.js";

type RunParams = Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0];
const config: OpenClawConfig = {};
const params = {
  config,
  prompt: "check",
  runId: "run-plugin",
  sessionId: "session-plugin",
  sessionTarget: {
    agentId: "researcher",
    sessionId: "session-plugin",
    sessionKey: "agent:researcher:plugin",
    storePath: "/tmp/sessions",
  },
  timeoutMs: 1,
  workspaceDir: "/tmp/workspace",
} satisfies RunParams;

function run(overrides: Partial<RunParams> = {}, pluginId = "memory-plugin") {
  return withPluginRuntimePluginScope({ pluginId }, () =>
    runPluginEmbeddedAgent({ ...params, ...overrides }),
  );
}

async function replies(
  exercise: (input: RunParams) => Promise<void>,
  overrides: Partial<RunParams> = {},
) {
  mocks.runEmbeddedAgentCore.mockImplementationOnce(async (input: RunParams) => {
    await exercise(input);
    return { payloads: [] };
  });
  return run({ onBlockReply: () => {}, ...overrides }, "reply-plugin");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorityActive = true;
  mocks.close.mockImplementation(() => {
    mocks.authorityActive = false;
  });
  mocks.prepareAgentRunAdmission.mockReturnValue({
    operationalRunInstance: { instanceId: "instance:run-plugin", runId: "run-plugin" },
    admit: vi.fn(),
    close: mocks.close,
  });
  mocks.runEmbeddedAgentCore.mockResolvedValue({ payloads: [] });
});

it.each(["explicit", "runtime"] as const)(
  "shares %s config between admission and execution and closes admission",
  async (configSource) => {
    const runParams = {
      ...params,
      config: configSource === "explicit" ? config : undefined,
      githubPublicationAvailable: configSource === "explicit",
    };
    if (configSource === "runtime") {
      mocks.getRuntimeConfig.mockReturnValueOnce(config);
    }
    await expect(run(runParams)).resolves.toEqual({ payloads: [] });

    expect(mocks.prepareAgentRunAdmission).toHaveBeenCalledWith({
      cfg: config,
      operationalRunInstance: { instanceId: "instance:run-plugin", runId: "run-plugin" },
      facts: {
        runId: "run-plugin",
        agentId: "researcher",
        ingress: {
          kind: "plugin",
          boundary: "plugin-runtime",
          rawSourceRef: "memory-plugin",
          state: "present",
        },
      },
      onAdmitted: expect.any(Function),
    });
    expect(mocks.runEmbeddedAgentCore).toHaveBeenCalledWith(
      expect.objectContaining({
        ...params,
        preparedRunAdmission: expect.objectContaining({ close: mocks.close }),
      }),
    );
    expect(mocks.runEmbeddedAgentCore).toHaveBeenCalledOnce();
    expect(mocks.runEmbeddedAgentCore.mock.calls[0]![0]).not.toHaveProperty(
      "githubPublicationAvailable",
    );
    expect(mocks.getRuntimeConfig).toHaveBeenCalledTimes(configSource === "runtime" ? 1 : 0);
    expect(mocks.close).toHaveBeenCalledOnce();
  },
);

it("closes the prepared admission when core execution throws", async () => {
  mocks.runEmbeddedAgentCore.mockRejectedValueOnce(new Error("core failed"));

  await expect(run()).rejects.toThrow("core failed");
  expect(mocks.close).toHaveBeenCalledOnce();
});

it("delegates the parent audience to the child session before core execution", async () => {
  const parentKey = "agent:researcher:parent";
  const entry = {
    sessionId: "00000000-0000-4000-8000-000000000001",
    updatedAt: 1,
    chatType: "direct" as const,
  };
  fakeSessionOwner.rows.set(parentKey, entry);
  const resolution = await resolveMemoryAudienceFromEntry(
    {
      ...params.sessionTarget,
      sessionKey: parentKey,
      sessionId: entry.sessionId,
      senderIsOwner: true,
    },
    entry,
  );
  assert(resolution.status === "granted");
  const audience = resolution.audience;
  fakeSessionOwner.rows.set("agent:researcher:plugin", {
    sessionId: "session-plugin",
    updatedAt: 1,
  });
  await run({ memoryAudience: audience });
  const childAudience = mocks.runEmbeddedAgentCore.mock.calls[0]![0].memoryAudience;
  expect(childAudience).toEqual(audience);
  expect(childAudience).not.toBe(audience);
  expect(() =>
    assertMemoryAudienceSession(childAudience, params.sessionTarget!.sessionKey),
  ).not.toThrow();
  expect(() => assertMemoryAudienceSession(childAudience, "agent:researcher:parent")).toThrow(
    "different session",
  );
  // The run releases its delegated grant when it ends.
  expect(() => assertMemoryAudienceCurrent(childAudience)).toThrow("released by its owner");
  expect(() => assertMemoryAudienceCurrent(audience)).not.toThrow();
});

it.each([
  "legacy-send",
  "legacy-send-then-throw",
  "legacy-pending-then-reject",
  "collector",
  "no-send",
] as const)("preserves %s reply custody", async (owner) => {
  const received: string[] = [];
  const legacy = owner.startsWith("legacy");
  const delayed = owner === "legacy-pending-then-reject";
  const rejects = owner === "legacy-send-then-throw" || owner === "no-send" || delayed;
  const callback = createDeferred();
  await replies(
    async (input) => {
      const reply = (async () =>
        input.onBlockReply?.({ text: "The note is saved." }, { assistantMessageIndex: 1 }))();
      if (delayed) {
        expect(await input.resolveReplyDelivery?.(0)).toBe("pending");
        callback.reject(new Error("transport callback rejected"));
      }
      if (rejects) {
        await expect(reply).rejects.toThrow("transport callback rejected");
      } else {
        await reply;
      }
      expect(await input.resolveReplyDelivery?.(0)).toBe(legacy ? "pending" : "missing");
    },
    {
      ...(!legacy ? { resolveReplyDelivery: async () => "missing" as const } : {}),
      onBlockReply: ({ text }) => {
        if (text && owner !== "no-send") {
          received.push(text);
        }
        if (delayed) {
          return callback.promise;
        }
        if (rejects) {
          throw new Error("transport callback rejected");
        }
      },
    },
  );
  expect(received).toEqual(owner === "no-send" ? [] : ["The note is saved."]);
});

it("does not turn previews, commentary, reasoning, or progress into final custody", async () => {
  await replies(
    async (input) => {
      await input.onPartialReply?.({ text: "Preview answer" });
      await input.onToolResult?.({ text: "Tool progress" });
      for (const payload of [
        { text: "Thinking", isReasoning: true },
        { text: "Working", isCommentary: true },
        { text: "Compacting", isCompactionNotice: true },
        { text: "Progress", channelData: { openclawProgressKind: "fast-mode-auto" } },
        { text: " " },
      ]) {
        await input.onBlockReply?.(payload, { assistantMessageIndex: 1 });
      }
      expect(await input.resolveReplyDelivery?.(0)).toBe("missing");
    },
    { onPartialReply: () => {}, onToolResult: () => {} },
  );
});

it("retains unindexed legacy custody only for the initial input", async () => {
  await replies(async (input) => {
    await input.onBlockReply?.({ text: "First answer" });
    expect(await input.resolveReplyDelivery?.(0)).toBe("pending");
    expect(await input.resolveReplyDelivery?.(1)).toBe("missing");
    await input.onBlockReply?.({ text: "Unscoped late answer" });
    expect(await input.resolveReplyDelivery?.(0)).toBe("missing");
    await input.onBlockReply?.(
      setReplyPayloadMetadata(
        { mediaUrls: ["https://example.com/answer.png"] },
        { assistantMessageIndex: 2 },
      ),
    );
    expect(await input.resolveReplyDelivery?.(1)).toBe("pending");
  });
});

it("does not restore earlier-input custody when an old callback resolves late", async () => {
  const accepted = createDeferred();
  await replies(
    async (input) => {
      const oldReply = input.onBlockReply?.({ text: "Old answer" }, { assistantMessageIndex: 1 });
      expect(await input.resolveReplyDelivery?.(2)).toBe("missing");
      accepted.resolve();
      await oldReply;
      expect(await input.resolveReplyDelivery?.(2)).toBe("missing");
      await input.onBlockReply?.({ text: "Current answer" }, { assistantMessageIndex: 2 });
      expect(await input.resolveReplyDelivery?.(2)).toBe("pending");
      expect(await input.resolveReplyDelivery?.(3)).toBe("missing");
      expect(await input.resolveReplyDelivery?.(0)).toBe("missing");
    },
    { onBlockReply: () => accepted.promise },
  );
});

it.each(["completion", "abort"] as const)(
  "records admission and closes authority on %s without leaking plugin identifiers",
  async (end) => {
    const core = createDeferred<{ payloads: never[] }>();
    const started = createDeferred();
    const accepted = createDeferred();
    let observe: RunParams["resolveReplyDelivery"];
    let lateReply: void | Promise<void> = undefined;
    const admittedRunContext: AdmittedRunContext = {
      operationalRunInstance: { instanceId: "instance:run-plugin", runId: "run-plugin" },
      executionIdentityToken: {
        tokenVersion: 1,
        contextId: "context-plugin",
        executionId: "execution-plugin",
        runId: "run-plugin",
        createdAt: 100,
      },
    };
    mocks.prepareAgentRunAdmission.mockImplementationOnce(
      (input: { onAdmitted?: (context: AdmittedRunContext) => void | Promise<void> }) => ({
        operationalRunInstance: admittedRunContext.operationalRunInstance,
        admit: async () => {
          await input.onAdmitted?.(admittedRunContext);
          return admittedRunContext;
        },
        close: mocks.close,
      }),
    );
    mocks.runEmbeddedAgentCore.mockImplementationOnce(async (input) => {
      await input.preparedRunAdmission.admit("plugin-harness");
      observe = input.resolveReplyDelivery;
      await input.onBlockReply?.({ text: "Accepted answer" }, { assistantMessageIndex: 1 });
      expect(await observe?.(0)).toBe("pending");
      if (end === "abort") {
        lateReply = input.onBlockReply?.({ text: "Late answer" }, { assistantMessageIndex: 2 });
      }
      started.resolve();
      return core.promise;
    });
    const receipts: DecisionReceiptV1[] = [];
    const clear = configureRuntimeActionDecisionSink((receipt) => {
      receipts.push(receipt);
      return true;
    });
    const controller = new AbortController();
    const running = run(
      {
        abortSignal: controller.signal,
        onBlockReply: ({ text }) => (text === "Late answer" ? accepted.promise : undefined),
      },
      "private-plugin-id",
    );
    try {
      await Promise.race([started.promise, running]);
      expect(mocks.runEmbeddedAgentCore).toHaveBeenCalledOnce();
      if (end === "abort") {
        controller.abort(new Error("cancelled"));
        expect(mocks.close).toHaveBeenCalledOnce();
        expect(await observe?.(0)).toBe("missing");
        accepted.resolve();
        await lateReply;
        expect(await observe?.(0)).toBe("missing");
      }
      core.resolve({ payloads: [] });
      await expect(running).resolves.toEqual({ payloads: [] });
      expect(await observe?.(0)).toBe("missing");
      expect(mocks.close).toHaveBeenCalledOnce();
      expect(
        receipts.map(({ decision, enforcement }) => [
          decision.outcome,
          decision.reasonCode,
          enforcement.coverageState,
        ]),
      ).toEqual([
        ["allowed", "plugin_runtime_owner_admitted", "enforced"],
        ...(end === "completion"
          ? [["allowed", "plugin_runtime_completed", "attribution-only"]]
          : []),
      ]);
      expect(JSON.stringify(receipts)).not.toContain("private-plugin-id");
    } finally {
      accepted.resolve();
      core.resolve({ payloads: [] });
      try {
        await running;
      } finally {
        clear();
      }
    }
  },
);

it.each(["before preparation", "during preparation"] as const)(
  "rejects cancellation %s without entering core execution",
  async (timing) => {
    const controller = new AbortController();
    const reason = timing === "before preparation" ? "already cancelled" : "raced cancellation";
    const cancel = () => controller.abort(new Error(reason));
    if (timing === "before preparation") {
      cancel();
    } else {
      mocks.prepareAgentRunAdmission.mockImplementationOnce(() => {
        cancel();
        return {
          operationalRunInstance: { instanceId: "instance:run-plugin", runId: "run-plugin" },
          admit: vi.fn(),
          close: mocks.close,
        };
      });
    }
    await expect(run({ abortSignal: controller.signal })).rejects.toThrow(reason);
    if (timing === "before preparation") {
      expect(mocks.prepareAgentRunAdmission).not.toHaveBeenCalled();
    } else {
      expect(mocks.close).toHaveBeenCalledOnce();
    }
    expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
  },
);

type Rejection = [name: string, patch: Record<string, unknown>, inherited?: boolean];
const accountingFields = [
  "compactionCountOwner",
  "onCompactionAccounting",
  "onContextAccountingEvent",
];
const hostFields = [
  "admittedRunContext",
  "preparedRunAdmission",
  "onDeferredLifecycleOwner",
  "onDeferredLifecycleAbort",
  "onRetryWait",
  ...accountingFields,
];
it.each<Rejection>([
  ["missing plugin scope", {}],
  ["forged memory audience", { memoryAudience: { kind: "owner-private", agentId: "researcher" } }],
  ...hostFields.map((field): Rejection => [
    field,
    { [field]: field === "compactionCountOwner" ? "caller" : {} },
  ]),
  ...accountingFields.map((field): Rejection => [
    `inherited ${field}`,
    { [field]: field === "compactionCountOwner" ? "caller" : vi.fn() },
    true,
  ]),
])("rejects %s before admission", async (name, patch, inherited) => {
  const input = { ...params, ...(!inherited ? patch : {}) };
  if (inherited) {
    Object.setPrototypeOf(input, patch);
  }
  const unscoped = name === "missing plugin scope";
  const message = unscoped
    ? "active plugin runtime scope"
    : name === "forged memory audience"
      ? "memory audience must be host-minted"
      : "cannot supply host run authority";
  const invoke = () => runPluginEmbeddedAgent(input);
  await expect(
    unscoped ? invoke() : withPluginRuntimePluginScope({ pluginId: "memory-plugin" }, invoke),
  ).rejects.toThrow(message);
  expect(mocks.prepareAgentRunAdmission).not.toHaveBeenCalled();
  expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
});
