import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { FailoverError } from "../../agents/failover-error.js";
import { prepareOperatorModelPolicy } from "../../agents/operator-model-policy.js";
import { createDiagnosticLogRecordCapture } from "../../logging/test-helpers/diagnostic-log-capture.js";
import { createWarnLogCapture } from "../../logging/test-helpers/warn-log-capture.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";

const runIsolatedCompletion = vi.hoisted(() => vi.fn());
const resolveSimpleCompletionSelectionForAgent = vi.hoisted(() => vi.fn());

vi.mock("../../agents/isolated-completion.js", () => ({ runIsolatedCompletion }));
vi.mock("../../agents/simple-completion-runtime.js", () => ({
  resolveSimpleCompletionSelectionForAgent,
}));

import {
  generateConversationLabel,
  generateConversationLabelWithFallback,
  type ConversationLabelParams,
} from "./conversation-label-generator.js";

const baseParams = { userMessage: "Message", prompt: "Prompt", cfg: {} };
const params = {
  ...baseParams,
  userMessage: "Need help with invoices",
  prompt: "Generate a label",
  agentId: "billing",
  utilityModelRef: "openai/gpt-mini@work",
  regularModelRef: "openai/gpt-main@work",
  preferredProfile: "work",
};
const generate = (overrides: Partial<ConversationLabelParams> = {}) =>
  generateConversationLabel({ ...baseParams, ...overrides });
const fallback = (
  overrides: Partial<Parameters<typeof generateConversationLabelWithFallback>[0]> = {},
) => generateConversationLabelWithFallback({ ...params, ...overrides });
const attemptedModels = () => runIsolatedCompletion.mock.calls.map(([request]) => request.model);
const attemptedRoutes = (...fields: string[]) =>
  runIsolatedCompletion.mock.calls.map(([request]) => fields.map((field) => request[field]));
const unavailable = () =>
  new FailoverError("Fixture server unavailable", { reason: "server_error" });
function expectCompletion(request: Record<string, unknown>) {
  expect(runIsolatedCompletion).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(request));
}
function modelConfig(
  model: string | { primary: string; fallbacks: string[] } | undefined,
  primary: string,
  fallbacks: string[],
) {
  return {
    agents: { defaults: { ...(model ? { model } : {}), utilityModel: { primary, fallbacks } } },
    plugins: { enabled: false },
  };
}

function resolveSelection({ modelRef, useUtilityModel, agentDir }: Record<string, unknown>) {
  const ref =
    typeof modelRef === "string"
      ? modelRef
      : useUtilityModel
        ? "openai/gpt-mini@work"
        : "openai/gpt-main@work";
  const [rawModel, profileId] = ref.split("@");
  const model = rawModel ?? "";
  const slash = model.indexOf("/");
  return {
    provider: model.slice(0, slash),
    modelId: model.slice(slash + 1),
    profileId,
    agentDir: typeof agentDir === "string" ? agentDir : "/tmp/openclaw-agent",
  };
}

beforeEach(() => {
  runIsolatedCompletion.mockReset();
  resolveSimpleCompletionSelectionForAgent.mockReset();
  resolveSimpleCompletionSelectionForAgent.mockImplementation(resolveSelection);
  runIsolatedCompletion.mockResolvedValue({ text: "Topic label" });
});

describe("generateConversationLabel", () => {
  it("uses utility backups for implicit thread and topic labels", async () => {
    runIsolatedCompletion
      .mockRejectedValueOnce(unavailable())
      .mockResolvedValueOnce({ text: "Garden planning" });

    await expect(
      generate({
        cfg: modelConfig("openai/gpt-main", "openai/gpt-mini", ["openai/utility-backup"]),
        agentId: "main",
      }),
    ).resolves.toBe("Garden planning");
    expect(attemptedModels()).toEqual(["gpt-mini", "utility-backup"]);
  });

  it("warns once per model per minute without exposing provider errors or title source", async () => {
    const warningLog = createWarnLogCapture("conversation-label");
    const logs = createDiagnosticLogRecordCapture();
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    runIsolatedCompletion.mockRejectedValue(new Error("secret-bearing provider failure"));
    const warningParams = {
      modelRef: "warning-provider/always-thinking@private-profile",
      prompt: "Generate a title",
      userMessage: "Private title source",
    };
    const expectFailure = () =>
      expect(generate(warningParams)).rejects.toThrow("conversation label generation failed");
    try {
      await expectFailure();
      now += 30_000;
      await expectFailure();
      now += 30_001;
      await expectFailure();
      await logs.flush();
      const warnings = logs.records.filter((record) =>
        record.message.includes("Conversation label generation failed"),
      );
      expect(warnings).toHaveLength(2);
      for (const warning of warnings) {
        expect(warning.message).toContain("warning-provider/always-thinking");
        expect(warning.message).toContain("utilityModel");
        expect(JSON.stringify(warning)).not.toMatch(
          /secret-bearing|private-profile|Private title source/,
        );
      }
    } finally {
      clock.mockRestore();
      logs.cleanup();
      warningLog.cleanup();
    }
  });

  it.each<{ primary: string; sessionRuntime?: string }>([
    { primary: "claude-sonnet" },
    { primary: "claude-opus", sessionRuntime: "openclaw" },
  ])(
    "keeps the utility label on its selected runtime ($primary, session=$sessionRuntime)",
    async ({ primary, sessionRuntime }) => {
      const cfg = {
        agents: {
          defaults: {
            model: `anthropic/${primary}`,
            models: { [`anthropic/${primary}`]: { agentRuntime: { id: "claude-cli" } } },
          },
        },
      };
      const metadataSnapshot = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "anthropic",
            providers: ["anthropic"],
            modelCatalog: {
              providers: { anthropic: { defaultUtilityModel: "claude-haiku", models: [] } },
            },
          },
        ],
      });
      await withPluginRuntimeGenerationScope({ metadataSnapshot }, () =>
        generateConversationLabelWithFallback({
          ...baseParams,
          cfg,
          agentId: "main",
          utilityModelRef: "anthropic/claude-haiku",
          regularModelRef: `anthropic/${primary}`,
          agentHarnessRuntimeOverride: sessionRuntime,
        }),
      );
      expectCompletion({
        model: "claude-haiku",
        agentHarnessRuntimeOverride: sessionRuntime ?? "claude-cli",
      });
    },
  );

  it("uses one explicit model and timeout when supplied", async () => {
    await generate({ modelRef: "anthropic/claude-haiku@team", timeoutMs: 900 });

    expectCompletion({
      provider: "anthropic",
      model: "claude-haiku",
      authProfileId: "team",
      timeoutMs: 900,
    });
  });

  it.each(["retired", "aborted"] as const)(
    "allows utility fallback only while its caller is active (%s)",
    async (state) => {
      const abort = new AbortController();
      const expired = new Error("The label owner retired.");
      let current = true;
      runIsolatedCompletion
        .mockImplementationOnce(async () => {
          current = state !== "retired";
          if (state === "aborted") {
            abort.abort(expired);
          }
          throw new Error("utility unavailable");
        })
        .mockResolvedValueOnce({ text: "Primary title" });

      const label = generate({
        abortSignal: abort.signal,
        assertCurrent() {
          if (!current) {
            throw expired;
          }
        },
      });
      await expect(label).rejects.toBe(expired);
      expect(runIsolatedCompletion).toHaveBeenCalledOnce();
    },
  );

  it("bounds without splitting surrogate pairs", async () => {
    runIsolatedCompletion.mockResolvedValue({ text: `${"a".repeat(11)}😀tail` });

    await expect(generate({ maxLength: 12 })).resolves.toBe("a".repeat(11));
  });
});

describe("generateConversationLabelWithFallback", () => {
  it("does not repeat a regular model already attempted by the utility chain", async () => {
    runIsolatedCompletion.mockRejectedValue(unavailable());
    await expect(
      fallback({ cfg: modelConfig(undefined, "openai/gpt-mini", ["openai/gpt-main"]) }),
    ).rejects.toThrow("conversation label generation failed");
    expect(attemptedModels()).toEqual(["gpt-mini", "gpt-main"]);
  });

  it("re-runs the regular model with the session runtime override after a utility attempt without it", async () => {
    runIsolatedCompletion.mockImplementation(
      async (request: { model?: string; agentHarnessRuntimeOverride?: string }) => {
        if (request.model === "gpt-main" && request.agentHarnessRuntimeOverride === "codex") {
          return { text: "Runtime recovery label" };
        }
        throw unavailable();
      },
    );
    await expect(
      fallback({
        cfg: modelConfig(undefined, "openai/gpt-mini", ["openai/gpt-main"]),
        agentHarnessRuntimeOverride: "codex",
      }),
    ).resolves.toBe("Runtime recovery label");
    expect(attemptedRoutes("model", "agentHarnessRuntimeOverride")).toEqual([
      ["gpt-mini", "codex"],
      ["gpt-main", undefined],
      ["gpt-main", "codex"],
    ]);
  });

  it.each(["regular model", "exhausted"] as const)(
    "uses the utility chain before the existing label recovery: %s",
    async (outcome) => {
      const cfg = modelConfig(
        { primary: "label-test/main", fallbacks: ["label-test/main-backup"] },
        "label-test/utility",
        ["label-test/utility-backup"],
      );
      runIsolatedCompletion.mockImplementation(async ({ model }) => {
        if (model === "main" && outcome === "regular model") {
          return { text: "Garden planning" };
        }
        throw unavailable();
      });

      const label = fallback({
        cfg,
        utilityModelRef: "label-test/utility",
        regularModelRef: "label-test/main",
      });

      if (outcome === "exhausted") {
        await expect(label).rejects.toThrow("conversation label generation failed");
      } else {
        await expect(label).resolves.toBe("Garden planning");
      }
      expect(attemptedModels()).toEqual(["utility", "utility-backup", "main"]);
    },
  );

  it.each([false, true])("skips denied utility primary (fallback=%s)", async (hasFallback) => {
    const cfg = {
      agents: {
        entries: { main: {} },
        defaults: modelConfig(
          "label-test/regular",
          "label-test/utility",
          hasFallback ? ["label-test/backup"] : [],
        ).agents.defaults,
      },
    };
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "label-reader",
      scopes: ["operator.write"],
      assertCurrent: () => {},
      modelPolicy: prepareOperatorModelPolicy({
        cfg,
        policy: {
          sourceAgent: "main",
          allow: ["label-test/*"],
          deny: ["label-test/utility"],
        },
        manifestPlugins: [],
      }),
    });
    await expect(
      fallback({
        cfg,
        agentId: "main",
        utilityModelRef: "label-test/utility",
        regularModelRef: "label-test/regular",
        operatorAuthority,
      }),
    ).resolves.toBe("Topic label");
    expectCompletion({
      provider: "label-test",
      model: hasFallback ? "backup" : "regular",
      operatorAuthority,
    });
  });

  it("records an exhausted failure after fallback normalization rejects the result", async () => {
    runIsolatedCompletion
      .mockRejectedValueOnce(new Error("secret-bearing provider failure"))
      .mockResolvedValueOnce({ text: "Title:" });

    await expect(
      fallback({ normalizeLabel: (label) => (label === "Title:" ? null : label) }),
    ).rejects.toThrow("conversation label generation failed (utility)");
    expect(runIsolatedCompletion).toHaveBeenCalledTimes(2);
  });

  it.each([
    { utilityModelRef: "openai/gpt-mini", provider: "openai", runtime: "codex", profile: "work" },
    { utilityModelRef: "anthropic/claude-haiku", provider: "anthropic" },
  ])("preserves compatible runtime and profile for $utilityModelRef fallback", async (row) => {
    if (row.provider === "openai") {
      runIsolatedCompletion.mockResolvedValueOnce({ text: "<think>private" });
    } else {
      runIsolatedCompletion.mockRejectedValueOnce(new Error("utility unavailable"));
    }
    runIsolatedCompletion.mockResolvedValueOnce({ text: "Primary title" });
    await expect(
      fallback({ utilityModelRef: row.utilityModelRef, agentHarnessRuntimeOverride: "codex" }),
    ).resolves.toBe("Primary title");
    expect(attemptedRoutes("provider", "agentHarnessRuntimeOverride", "authProfileId")).toEqual([
      [row.provider, row.runtime, row.profile],
      ["openai", "codex", "work"],
    ]);
  });

  it("utilityOnly returns null without inference when the utility model resolves onto the primary", async () => {
    await expect(
      fallback({ utilityModelRef: params.regularModelRef, utilityOnly: true }),
    ).resolves.toBeNull();
    expect(runIsolatedCompletion).not.toHaveBeenCalled();
  });

  it("uses the regular candidate directly when no utility model exists", async () => {
    const { utilityModelRef: _utilityModelRef, ...regularOnlyParams } = params;
    await generateConversationLabelWithFallback(regularOnlyParams);
    expect(runIsolatedCompletion.mock.calls[0]?.[0]?.model).toBe("gpt-main");
  });
});
