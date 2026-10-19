import { afterEach, describe, expect, it, vi } from "vitest";
import * as pluginMetadata from "../plugins/plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  claimSessionControllerTask,
  releaseSessionControllerClaim,
  retireSessionControllerInput,
  trackSessionControllerSourceWork,
} from "../sessions/session-controller.mailbox.js";
import { registerRpcSource } from "../sessions/session-controller.rpc-sources.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewayLiveTestModel,
  formatGatewayLiveFailureDiagnostic,
  formatGatewayLiveAgentWaitFailure,
  isGatewayAgentWaitCompletedWithoutReply,
  waitForGatewayAgentRun,
  isolateLiveGatewayConfig,
  resolveExplicitLiveModelCandidates,
} from "./gateway-models.profiles.live.test-helpers.js";
import { createRpcSourceForTest } from "./test-helpers.rpc-source.js";

vi.mock("../agents/live-provider-owner.js", () => {
  const anthropicOwned = new Set(["anthropic", "claude-cli"]);
  return {
    liveProvidersShareOwningPlugin(left: string, right: string): boolean {
      return anthropicOwned.has(left) && anthropicOwned.has(right);
    },
  };
});

describe("isolateLiveGatewayConfig", () => {
  it("disables independent session-observer model traffic", () => {
    expect(
      isolateLiveGatewayConfig({
        gateway: { controlUi: { enabled: false, sessionObserver: true } },
      }).gateway?.controlUi,
    ).toMatchObject({ enabled: false, sessionObserver: false });
  });
});

describe("resolveExplicitLiveModelCandidates", () => {
  const pro = createGatewayLiveTestModel("deepseek", "deepseek-v4-pro");
  const anthropic = createGatewayLiveTestModel("anthropic", "claude-sonnet-4-6");
  const google = createGatewayLiveTestModel("google", "gemini-3.1-pro-preview");

  it.each(["deepseek/deepseek-v4-flash", "deepseek/"])(
    "rejects incomplete explicit selection %s even when another requested model exists",
    (missingRef) => {
      expect(() =>
        resolveExplicitLiveModelCandidates({
          modelRegistry: { find: (_provider, id) => (id === pro.id ? pro : undefined) },
          models: [pro],
          modelFilter: new Set([missingRef, "deepseek/deepseek-v4-pro"]),
          providerFilter: new Set(["deepseek"]),
          env: {},
        }),
      ).toThrow(`explicit model selection missed requested models: ${missingRef}.`);
    },
  );

  it("keeps canonical metadata from a targeted lookup outside the enumerated catalog", () => {
    const canonical = { ...pro, contextWindow: 234_567 };
    expect(
      resolveExplicitLiveModelCandidates({
        modelRegistry: { find: () => canonical },
        models: [],
        modelFilter: new Set(["deepseek/deepseek-v4-pro"]),
        providerFilter: new Set(["deepseek"]),
        env: {},
      }),
    ).toEqual([canonical]);
  });

  it("rejects an explicit ref without canonical metadata", () => {
    expect(() =>
      resolveExplicitLiveModelCandidates({
        modelRegistry: { find: () => undefined },
        models: [],
        modelFilter: new Set(["deepseek/missing-model"]),
        providerFilter: new Set(["deepseek"]),
        env: {},
      }),
    ).toThrow(/deepseek\/missing-model/);
  });

  it("normalizes retired Google refs before targeted lookup", () => {
    expect(
      resolveExplicitLiveModelCandidates({
        modelRegistry: {
          find: (provider, id) =>
            provider === google.provider && id === google.id ? google : undefined,
        },
        models: [],
        modelFilter: new Set(["google/gemini-3-pro-preview"]),
        providerFilter: new Set(["google"]),
        env: {},
      }),
    ).toEqual([google]);
  });

  it.each([
    {
      name: "case-insensitive references",
      refs: ["DEEPSEEK/DEEPSEEK-V4-PRO"],
      providers: ["deepseek"],
      models: [pro],
      expected: [pro],
    },
    {
      name: "provider ownership aliases",
      refs: ["claude-cli/claude-sonnet-4-6"],
      providers: ["claude-cli"],
      models: [anthropic],
      expected: [anthropic],
    },
    {
      name: "equivalent selectors",
      refs: ["claude-cli/claude-sonnet-4-6", "ANTHROPIC/CLAUDE-SONNET-4-6"],
      providers: ["anthropic"],
      models: [anthropic],
      expected: [anthropic],
    },
    {
      name: "provider allowlist intersection",
      refs: ["anthropic/claude-sonnet-4-6", "deepseek/deepseek-v4-pro"],
      providers: ["deepseek"],
      models: [anthropic, pro],
      expected: [pro],
    },
    {
      name: "ambiguous model-only selectors",
      refs: ["shared-model"],
      providers: null,
      models: [
        createGatewayLiveTestModel("provider-one", "shared-model"),
        createGatewayLiveTestModel("provider-two", "shared-model"),
      ],
      expected: [
        createGatewayLiveTestModel("provider-one", "shared-model"),
        createGatewayLiveTestModel("provider-two", "shared-model"),
      ],
    },
  ])("keeps matcher enumeration for $name", ({ refs, providers, models, expected }) => {
    expect(
      resolveExplicitLiveModelCandidates({
        modelRegistry: { find: () => undefined },
        models,
        modelFilter: new Set(refs),
        providerFilter: providers ? new Set(providers) : null,
        env: {},
      }),
    ).toEqual(expected);
  });

  it("keeps targeted Bedrock metadata when another selector requires enumeration", () => {
    const shared = createGatewayLiveTestModel("provider-one", "shared-model");
    expect(
      resolveExplicitLiveModelCandidates({
        modelRegistry: { find: () => undefined },
        models: [shared],
        modelFilter: new Set(["amazon-bedrock/global.anthropic.claude-sonnet-4-6", "shared-model"]),
        providerFilter: null,
        env: {},
      }),
    ).toMatchObject([
      {
        provider: "amazon-bedrock",
        id: "global.anthropic.claude-sonnet-4-6",
        api: "bedrock-converse-stream",
      },
      { provider: "provider-one", id: "shared-model" },
    ]);
  });

  it("preserves targeted metadata and scope while another selector enumerates", () => {
    const canonical = { ...anthropic, contextWindow: 234_567 };
    const shared = createGatewayLiveTestModel("provider-one", "shared-model");
    expect(
      resolveExplicitLiveModelCandidates({
        modelRegistry: {
          find: (provider, id) =>
            provider === canonical.provider && id === canonical.id ? canonical : undefined,
        },
        models: [anthropic, createGatewayLiveTestModel("claude-cli", anthropic.id), shared],
        modelFilter: new Set(["anthropic/claude-sonnet-4-6", "shared-model"]),
        providerFilter: null,
        env: {},
      }),
    ).toEqual([canonical, shared]);
  });

  it("applies the selected workspace's retirement policy to the model's actual route", () => {
    const workspaceDir = "/fixture/workspace";
    const empty = createPluginMetadataSnapshotFixture();
    const scoped = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "workspace-fixture",
          origin: "workspace",
          providers: ["workspace-fixture"],
          modelCatalog: {
            suppressions: [
              {
                provider: "workspace-fixture",
                model: "retired-model",
                retirement: { replacedBy: "current-model" },
                when: { baseUrlHosts: ["models.example.invalid"] },
              },
            ],
          },
        },
      ],
    });
    const metadata = vi
      .spyOn(pluginMetadata, "resolvePluginMetadataSnapshot")
      .mockImplementation((params) => (params.workspaceDir === workspaceDir ? scoped : empty));
    const retired = {
      ...createGatewayLiveTestModel("workspace-fixture", "retired-model"),
      baseUrl: "https://models.example.invalid/v1",
    };
    const config = { plugins: { entries: { "workspace-fixture": { enabled: true } } } };
    const select = (model: typeof retired) =>
      resolveExplicitLiveModelCandidates({
        modelRegistry: { find: () => model },
        models: [model],
        modelFilter: new Set(["workspace-fixture/retired-model"]),
        providerFilter: new Set(["workspace-fixture"]),
        config,
        workspaceDir,
        env: {},
      });
    try {
      expect(() => select(retired)).toThrow(/workspace-fixture\/retired-model/);
      const customRoute = { ...retired, baseUrl: "https://custom.example.invalid/v1" };
      expect(select(customRoute)).toEqual([customRoute]);
    } finally {
      metadata.mockRestore();
    }
  });

  it("preserves the existing Bedrock Converse fallback", () => {
    expect(
      resolveExplicitLiveModelCandidates({
        modelRegistry: { find: () => undefined },
        models: [],
        modelFilter: new Set(["amazon-bedrock/global.anthropic.claude-sonnet-4-6"]),
        providerFilter: new Set(["amazon-bedrock"]),
        env: {},
      }),
    ).toMatchObject([
      {
        provider: "amazon-bedrock",
        id: "global.anthropic.claude-sonnet-4-6",
        api: "bedrock-converse-stream",
      },
    ]);
  });
});

describe("formatGatewayLiveFailureDiagnostic", () => {
  it.each([
    ["google", "gemini-3.1-pro-preview", "503 Service unavailable", "provider-unavailable", 503],
    ["anthropic", "claude-sonnet-4-6", "429 rate limit", "rate-limit", 429],
    ["google", "gemini-3.1-pro-preview", "request timed out", "timeout", undefined],
    [
      "google",
      "gemini-3.1-pro-preview",
      "upstream error from google",
      "provider-unavailable",
      undefined,
    ],
    ["google", "gemini-3.1-pro-preview", "unexpected reply", "unclassified", undefined],
  ])(
    "preserves %s failure facts through the agent.wait envelope: %s / %s",
    (provider, model, message, classification, explicitHttpStatus) => {
      const error = formatGatewayLiveAgentWaitFailure({
        context: "probe",
        runId: "private-run-id",
        result: { status: "error", error: message, providerStarted: true },
      });
      expect(
        JSON.parse(
          formatGatewayLiveFailureDiagnostic({ provider, model, phase: "tool-read", error }),
        ),
      ).toEqual({
        provider,
        model,
        phase: "tool-read",
        classification,
        ...(explicitHttpStatus ? { explicitHttpStatus } : {}),
        providerStarted: true,
      });
    },
  );

  it("omits bodies, URLs, credentials and arbitrary exception metadata without losing explicit status", () => {
    const body =
      "private-customer-body https://private.invalid/customer?note=private-value Bearer synthetic-private-token";
    const error = Object.assign(new Error(`503 Service unavailable ${body}`), {
      code: "OPAQUE_PRIVATE_CREDENTIAL",
      provider: body,
      model: body,
      cause: { classification: body, providerStarted: body },
    });
    for (const failure of [
      error,
      formatGatewayLiveAgentWaitFailure({
        context: body,
        runId: body,
        result: { status: body, error: error.message, providerStarted: body, stopReason: body },
      }),
    ]) {
      const diagnostic = formatGatewayLiveFailureDiagnostic({
        provider: "google",
        model: "gemini-3.1-pro-preview",
        phase: "tool-read",
        error: failure,
      });
      expect(JSON.parse(diagnostic)).toEqual({
        provider: "google",
        model: "gemini-3.1-pro-preview",
        phase: "tool-read",
        classification: "provider-unavailable",
        explicitHttpStatus: 503,
      });
      expect(diagnostic).not.toMatch(/private|https|Bearer|OPAQUE/);
    }
  });

  it.each([
    ["p".repeat(128), "m".repeat(256)],
    ["p".repeat(129), "m".repeat(257)],
    ["https://private.invalid", "model\nprivate"],
  ])("keeps identifiers bounded and emits valid JSON", (provider, model) => {
    const diagnostic = formatGatewayLiveFailureDiagnostic({
      provider,
      model,
      phase: "tool-only-followup",
      error: new Error("x".repeat(10_000)),
    });
    expect(`[live] failure ${diagnostic}\n`.length).toBeLessThanOrEqual(1024);
    expect(JSON.parse(diagnostic)).toMatchObject({
      phase: "tool-only-followup",
      classification: "unclassified",
    });
    expect(diagnostic).not.toMatch(/private|https|xxxxx/);
  });
});

describe("formatGatewayLiveAgentWaitFailure", () => {
  it("retains body-free failure evidence before agent.wait flattens the provider error", () => {
    const failure = formatGatewayLiveAgentWaitFailure({
      context: "google tool-read",
      runId: "private-run-id",
      result: {
        status: "error",
        error: "503 Service unavailable: private response body https://private.invalid/customer",
        providerStarted: true,
      },
    });
    expect(failure.cause).toEqual({
      classification: "provider-unavailable",
      explicitHttpStatus: 503,
      providerStarted: true,
    });
  });

  it("includes terminal attribution fields without requiring transcript text", () => {
    expect(
      formatGatewayLiveAgentWaitFailure({
        context: "anthropic prompt",
        runId: "run-1",
        result: {
          status: "timeout",
          timeoutPhase: "provider",
          providerStarted: true,
          stopReason: "rpc",
        },
      }).message,
    ).toContain(
      "anthropic prompt: agent.wait timeout for runId=run-1 (timeoutPhase=provider, providerStarted=true, stopReason=rpc)",
    );
  });
});

describe("isGatewayAgentWaitCompletedWithoutReply", () => {
  it("accepts the malformed completion envelope used by tool-only turns", () => {
    expect(isGatewayAgentWaitCompletedWithoutReply({ status: "error", error: " completed " })).toBe(
      true,
    );
  });

  it("rejects genuine agent errors and non-error completion envelopes", () => {
    expect(isGatewayAgentWaitCompletedWithoutReply({ status: "error", error: "aborted" })).toBe(
      false,
    );
    expect(isGatewayAgentWaitCompletedWithoutReply({ status: "ok", error: "completed" })).toBe(
      false,
    );
  });
});

describe("waitForGatewayAgentRun", () => {
  afterEach(() => vi.useRealTimers());

  it("starts the publication clock only after the accepted source settles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const runId = "live-source-clock";
    const source = createRpcSourceForTest({ kind: "agent" }, { runId });
    registerRpcSource(runId, source);
    const claim = await claimSessionControllerTask(source.input, () => {});
    const producer = createDeferredCore();
    trackSessionControllerSourceWork(source.input, producer.promise);
    const request = vi.fn().mockResolvedValue({
      status: "timeout",
      timeoutPhase: "provider",
      providerStarted: true,
      error: "request timed out",
    });
    let settled = false;
    const waiting = waitForGatewayAgentRun({
      client: { request },
      runId,
      context: "prompt",
      timeoutMs: 280_000,
    })
      .catch((error: unknown) => error)
      .then((result) => {
        settled = true;
        return result;
      });
    try {
      // Retained release timing: 12s preparation followed by a 270s runtime budget.
      // Public agent.wait's terminal/publication semantics have their own owner tests.
      await vi.advanceTimersByTimeAsync(12_000 + 268_000);
      expect(settled).toBe(false);
      expect(request).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      producer.resolve();
      releaseSessionControllerClaim(claim);
      expect(await waiting).toMatchObject({
        message: expect.stringContaining("timeoutPhase=provider, providerStarted=true"),
      });
      expect(request).toHaveBeenCalledExactlyOnceWith(
        "agent.wait",
        { runId, timeoutMs: 280_000 },
        { timeoutMs: 285_000 },
      );
    } finally {
      producer.resolve();
      releaseSessionControllerClaim(claim);
      await waiting;
    }
  });

  it("propagates rejected source cleanup without inventing terminal success", async () => {
    const runId = "live-source-rejection";
    const source = createRpcSourceForTest({ kind: "agent" }, { runId });
    registerRpcSource(runId, source);
    const claim = await claimSessionControllerTask(source.input, () => {});
    const producer = createDeferredCore();
    trackSessionControllerSourceWork(source.input, producer.promise);
    const request = vi.fn();
    const waiting = waitForGatewayAgentRun({
      client: { request },
      runId,
      context: "prompt",
      timeoutMs: 280_000,
    });
    const error = new Error("source cleanup failed");
    const rejected = expect(waiting).rejects.toBe(error);
    producer.reject(error);
    releaseSessionControllerClaim(claim);
    await rejected;
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["absent", "retired"] as const)(
    "checks the public terminal when the source is %s",
    async (state) => {
      const runId = "live-source-" + state;
      if (state === "retired") {
        const source = createRpcSourceForTest({ kind: "agent" }, { runId });
        registerRpcSource(runId, source);
        retireSessionControllerInput(source.input);
        await source.input.settlement.promise;
      }
      const request = vi.fn().mockResolvedValue({ status: "ok" });
      await expect(
        waitForGatewayAgentRun({
          client: { request },
          runId,
          context: "prompt",
          timeoutMs: 280_000,
        }),
      ).resolves.toBeUndefined();
      expect(request).toHaveBeenCalledOnce();
    },
  );
});
