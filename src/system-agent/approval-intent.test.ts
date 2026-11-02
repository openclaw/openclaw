// Approval-intent tests: closed-list fast path plus model-judged classification.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as simpleCompletion from "../agents/simple-completion-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { classifySystemAgentApprovalIntent as classifySystemAgentApprovalIntentImpl } from "./approval-intent.js";
import { classifySystemAgentApprovalText } from "./operator-approval.js";
import {
  createSystemAgentVerifiedInferenceTestFixture,
  installSystemAgentClaudeCliBackendTestFixture,
  createSystemAgentPluginMetadataTestSnapshot,
  type SystemAgentPluginMetadataTestSnapshot,
} from "./system-agent.test-helpers.js";
import type { SystemAgentVerifiedInferenceBinding } from "./verified-inference.js";
import * as verifiedInference from "./verified-inference.js";

const DEFAULT_MODEL = "openai/gpt-5.5@openai:p2";
const CLI_MODEL = "claude-cli/claude-opus-4-8";

function verifiedInferenceConfig(model: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model,
        ...(model.startsWith("openai/")
          ? { models: { "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } } } }
          : {}),
      },
    },
    auth: {
      order: { openai: ["openai:p1", "openai:p2"] },
      profiles: {
        "openai:p1": { provider: "openai", mode: "api_key" },
        "openai:p2": { provider: "openai", mode: "api_key" },
      },
    },
  };
}

async function createVerifiedInference(
  model = "openai/gpt-5.5@openai:p2",
  metadata = cliPluginMetadataSnapshot!,
): Promise<SystemAgentVerifiedInferenceBinding> {
  return metadata.run(
    async () =>
      (await createSystemAgentVerifiedInferenceTestFixture(verifiedInferenceConfig(model))).binding,
    verifiedInferenceConfig(model),
  );
}

let sharedVerifiedInference: SystemAgentVerifiedInferenceBinding;
let restoreCliBackendFixture: (() => void) | undefined;
let cliPluginMetadataSnapshot: SystemAgentPluginMetadataTestSnapshot | undefined;

const classify = (binding = sharedVerifiedInference, message = "alright then", proposal?: string) =>
  cliPluginMetadataSnapshot!.run(() =>
    classifySystemAgentApprovalIntentImpl({ message, proposal, verifiedInference: binding }),
  );

beforeAll(async () => {
  restoreCliBackendFixture = installSystemAgentClaudeCliBackendTestFixture();
  const defaultSnapshot = createSystemAgentPluginMetadataTestSnapshot(
    verifiedInferenceConfig(DEFAULT_MODEL),
  );
  sharedVerifiedInference = await createVerifiedInference(DEFAULT_MODEL, defaultSnapshot);
  cliPluginMetadataSnapshot = createSystemAgentPluginMetadataTestSnapshot(
    verifiedInferenceConfig(CLI_MODEL),
  );
});

afterAll(() => restoreCliBackendFixture?.());

afterEach(() => vi.restoreAllMocks());

function preparedModel(
  binding: SystemAgentVerifiedInferenceBinding,
  profileId = binding.execution.authProfileId,
  sourceAuthFingerprint: string | undefined = binding.auth.authFingerprint,
) {
  const route = binding.execution;
  return {
    [Symbol.asyncDispose]: async () => {},
    model: {},
    auth: { profileId },
    sourceAuthFingerprint,
    selection: {
      provider: route.provider,
      modelId: route.model,
      profileId,
      agentDir: route.agentDir,
    },
  } as never;
}

function completionDeps(replyText = "approve", binding = sharedVerifiedInference) {
  return {
    resolveRoute: vi
      .spyOn(verifiedInference, "resolveSystemAgentVerifiedInferenceRoute")
      .mockResolvedValue(binding.execution),
    acquire: vi
      .spyOn(simpleCompletion, "acquireSimpleCompletionModelForAgent")
      .mockResolvedValue(preparedModel(binding)),
    complete: vi
      .spyOn(simpleCompletion, "completeWithPreparedSimpleCompletionModel")
      .mockResolvedValue({ content: [{ type: "text", text: replyText }] } as never),
  };
}

it.each([
  ["approve", ["yes", "Yes.", "sure", "ok!", "Okay,", "go ahead", "yes please", "do it"]],
  ["decline", ["no", "no thanks", "not now", "cancel", "don't", "nah, later"]],
  ["other", ["maybe", "what does that change?", "yes but use gpt instead", ""]],
] as const)("classifySystemAgentApprovalText classifies %s phrases", (intent, phrases) => {
  for (const text of phrases) {
    expect(classifySystemAgentApprovalText(text)).toBe(intent);
  }
});

describe("classifySystemAgentApprovalIntent", () => {
  it("short-circuits closed-list answers without a model call", async () => {
    const deps = completionDeps();
    await expect(classify(sharedVerifiedInference, "yes")).resolves.toBe("approve");
    expect(deps.resolveRoute).not.toHaveBeenCalled();
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it("pins ambiguous approvals to the verified model and profile", async () => {
    const binding = sharedVerifiedInference;
    const deps = completionDeps("approve", binding);
    await expect(
      classify(binding, "alright, ship that change", "set config gateway.port to 19001"),
    ).resolves.toBe("approve");
    expect(deps.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: binding.execution.agentDir,
        modelRef: "openai/gpt-5.5@openai:p2",
        preferredProfile: "openai:p2",
      }),
    );
    expect(deps.complete).toHaveBeenCalledOnce();
  });

  it("fails closed to other on unexpected model output", async () => {
    completionDeps("I think the user probably agrees");
    await expect(classify(sharedVerifiedInference, "hmm alright I guess?")).resolves.toBe("other");
  });

  it("fails closed to other when no model is usable", async () => {
    const deps = completionDeps();
    deps.acquire.mockResolvedValueOnce({ error: "no model" });
    await expect(classify(sharedVerifiedInference)).resolves.toBe("other");
  });

  it("rejects a prepared auth owner that differs from the verified profile", async () => {
    const deps = completionDeps();
    deps.acquire.mockResolvedValueOnce(preparedModel(sharedVerifiedInference, "openai:p1"));
    await expect(classify()).resolves.toBe("other");
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it("rejects a same-profile credential rotation during preparation", async () => {
    const deps = completionDeps();
    deps.acquire.mockResolvedValueOnce(
      preparedModel(sharedVerifiedInference, "openai:p2", "different-p2-owner"),
    );
    await expect(classify()).resolves.toBe("other");
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it("keeps ambiguous CLI approvals on the exact-text path", async () => {
    const binding = await createVerifiedInference(CLI_MODEL);
    const deps = completionDeps("approve", binding);

    await expect(classify(binding)).resolves.toBe("other");
    expect(deps.acquire).not.toHaveBeenCalled();
  });

  it("rejects a verdict when the verified owner drifts during classification", async () => {
    const binding = await createVerifiedInference(DEFAULT_MODEL);
    const deps = completionDeps("approve", binding);
    deps.resolveRoute.mockResolvedValueOnce(binding.execution).mockResolvedValueOnce(null);

    await expect(classify(binding)).resolves.toBe("other");
  });
});
