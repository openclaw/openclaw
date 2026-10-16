/** Tests generated conversation labels for reply sessions. */
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
} from "./conversation-label-generator.js";

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
      .mockRejectedValueOnce(
        new FailoverError("Fixture server unavailable", { reason: "server_error" }),
      )
      .mockResolvedValueOnce({ text: "Garden planning" });

    await expect(
      generateConversationLabel({
        cfg: {
          agents: {
            defaults: {
              model: "openai/gpt-main",
              utilityModel: {
                primary: "openai/gpt-mini",
                fallbacks: ["openai/utility-backup"],
              },
            },
          },
          plugins: { enabled: false },
        },
        agentId: "main",
        userMessage: "Plan a garden.",
        prompt: "Generate a label.",
      }),
    ).resolves.toBe("Garden planning");
    expect(runIsolatedCompletion.mock.calls.map(([request]) => request.model)).toEqual([
      "gpt-mini",
      "utility-backup",
    ]);
  });

  it("warns once per model per minute without exposing provider errors or title source", async () => {
    const warningLog = createWarnLogCapture("conversation-label");
    const logs = createDiagnosticLogRecordCapture();
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    runIsolatedCompletion.mockRejectedValue(new Error("secret-bearing provider failure"));
    const params = {
      cfg: {},
      modelRef: "warning-provider/always-thinking@private-profile",
      prompt: "Generate a title",
      userMessage: "Private title source",
    };
    const generate = () =>
      expect(generateConversationLabel(params)).rejects.toThrow(
        "conversation label generation failed",
      );
    try {
      await generate();
      now += 30_000;
      await generate();
      now += 30_001;
      await generate();
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
      const utilityModel = "anthropic/claude-haiku";
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
          cfg,
          agentId: "main",
          utilityModelRef: utilityModel,
          regularModelRef: `anthropic/${primary}`,
          agentHarnessRuntimeOverride: sessionRuntime,
          prompt: "Return a session title.",
          userMessage: "Plan a garden.",
        }),
      );
      expect(runIsolatedCompletion).toHaveBeenCalledOnce();
      expect(runIsolatedCompletion.mock.calls[0]?.[0]).toMatchObject({
        model: "claude-haiku",
        agentHarnessRuntimeOverride: sessionRuntime ?? "claude-cli",
      });
    },
  );

  it("uses one explicit model and timeout when supplied", async () => {
    await generateConversationLabel({
      userMessage: "Message",
      prompt: "Prompt",
      cfg: {},
      modelRef: "anthropic/claude-haiku@team",
      timeoutMs: 900,
    });

    expect(runIsolatedCompletion).toHaveBeenCalledOnce();
    expect(runIsolatedCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-haiku",
        authProfileId: "team",
        timeoutMs: 900,
      }),
    );
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

      const label = generateConversationLabel({
        userMessage: "Message",
        prompt: "Prompt",
        cfg: {},
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

    await expect(
      generateConversationLabel({
        userMessage: "Message",
        prompt: "Prompt",
        cfg: {},
        maxLength: 12,
      }),
    ).resolves.toBe("a".repeat(11));
  });
});

describe("generateConversationLabelWithFallback", () => {
  const params = {
    userMessage: "Need help with invoices",
    prompt: "Generate a label",
    cfg: {},
    agentId: "billing",
    utilityModelRef: "openai/gpt-mini@work",
    regularModelRef: "openai/gpt-main@work",
    preferredProfile: "work",
  };

  it("does not repeat a regular model already attempted by the utility chain", async () => {
    runIsolatedCompletion.mockRejectedValue(
      new FailoverError("Fixture server unavailable", { reason: "server_error" }),
    );
    await expect(
      generateConversationLabelWithFallback({
        ...params,
        cfg: {
          agents: {
            defaults: {
              utilityModel: {
                primary: "openai/gpt-mini",
                fallbacks: ["openai/gpt-main"],
              },
            },
          },
          plugins: { enabled: false },
        },
      }),
    ).rejects.toThrow("conversation label generation failed");
    expect(runIsolatedCompletion.mock.calls.map(([request]) => request.model)).toEqual([
      "gpt-mini",
      "gpt-main",
    ]);
  });

  it.each(["utility backup", "regular model", "exhausted"] as const)(
    "uses the utility chain before the existing label recovery: %s",
    async (outcome) => {
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "label-test/main", fallbacks: ["label-test/main-backup"] },
            utilityModel: {
              primary: "label-test/utility",
              fallbacks: ["label-test/utility-backup"],
            },
          },
        },
        plugins: { enabled: false },
      };
      runIsolatedCompletion.mockImplementation(async ({ model }) => {
        if (
          (model === "utility-backup" && outcome === "utility backup") ||
          (model === "main" && outcome === "regular model")
        ) {
          return { text: "Garden planning" };
        }
        throw new FailoverError("Fixture server unavailable", { reason: "server_error" });
      });

      const label = generateConversationLabelWithFallback({
        ...params,
        cfg,
        utilityModelRef: "label-test/utility",
        regularModelRef: "label-test/main",
      });

      if (outcome === "exhausted") {
        await expect(label).rejects.toThrow("conversation label generation failed");
      } else {
        await expect(label).resolves.toBe("Garden planning");
      }
      expect(runIsolatedCompletion.mock.calls.map(([request]) => request.model)).toEqual(
        outcome === "utility backup"
          ? ["utility", "utility-backup"]
          : ["utility", "utility-backup", "main"],
      );
    },
  );

  it.each([false, true])(
    "skips a denied utility primary: utility fallback=%s",
    async (fallback) => {
      const cfg = {
        agents: {
          entries: { main: {} },
          defaults: {
            model: "label-test/regular",
            utilityModel: {
              primary: "label-test/utility",
              fallbacks: fallback ? ["label-test/backup"] : [],
            },
          },
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
        generateConversationLabelWithFallback({
          ...params,
          cfg,
          agentId: "main",
          utilityModelRef: "label-test/utility",
          regularModelRef: "label-test/regular",
          operatorAuthority,
        }),
      ).resolves.toBe("Topic label");
      expect(runIsolatedCompletion).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          provider: "label-test",
          model: fallback ? "backup" : "regular",
          operatorAuthority,
        }),
      );
    },
  );

  it("records an exhausted failure after fallback normalization rejects the result", async () => {
    runIsolatedCompletion
      .mockRejectedValueOnce(new Error("secret-bearing provider failure"))
      .mockResolvedValueOnce({ text: "Title:" });

    await expect(
      generateConversationLabelWithFallback({
        ...params,
        normalizeLabel: (label) => (label === "Title:" ? null : label),
      }),
    ).rejects.toThrow("conversation label generation failed (utility)");
    expect(runIsolatedCompletion).toHaveBeenCalledTimes(2);
  });

  it("keeps the runtime owner and inherited profile during reasoning-only fallback", async () => {
    runIsolatedCompletion
      .mockResolvedValueOnce({ text: "<think>private" })
      .mockResolvedValueOnce({ text: "Primary title" });

    await expect(
      generateConversationLabelWithFallback({
        ...params,
        utilityModelRef: "openai/gpt-mini",
        agentHarnessRuntimeOverride: "codex",
      }),
    ).resolves.toBe("Primary title");

    expect(
      runIsolatedCompletion.mock.calls.map(([request]) => request.agentHarnessRuntimeOverride),
    ).toEqual(["codex", "codex"]);
    expect(runIsolatedCompletion.mock.calls.map(([request]) => request.authProfileId)).toEqual([
      "work",
      "work",
    ]);
  });

  it("keeps only the compatible runtime per attempt when providers differ", async () => {
    runIsolatedCompletion
      .mockRejectedValueOnce(new Error("utility unavailable"))
      .mockResolvedValueOnce({ text: "Primary title" });

    await expect(
      generateConversationLabelWithFallback({
        ...params,
        utilityModelRef: "anthropic/claude-haiku",
        agentHarnessRuntimeOverride: "codex",
      }),
    ).resolves.toBe("Primary title");

    expect(
      runIsolatedCompletion.mock.calls.map(([request]) => [
        request.provider,
        request.agentHarnessRuntimeOverride,
      ]),
    ).toEqual([
      ["anthropic", undefined],
      ["openai", "codex"],
    ]);
    expect(runIsolatedCompletion.mock.calls[0]?.[0]?.authProfileId).toBeUndefined();
  });

  it("utilityOnly returns null without inference when the utility model resolves onto the primary", async () => {
    await expect(
      generateConversationLabelWithFallback({
        ...params,
        utilityModelRef: params.regularModelRef,
        utilityOnly: true,
      }),
    ).resolves.toBeNull();
    expect(runIsolatedCompletion).not.toHaveBeenCalled();
  });

  it("uses the regular candidate directly when no utility model exists", async () => {
    const { utilityModelRef: _utilityModelRef, ...regularOnlyParams } = params;
    await generateConversationLabelWithFallback(regularOnlyParams);
    expect(runIsolatedCompletion.mock.calls[0]?.[0]?.model).toBe("gpt-main");
  });
});
