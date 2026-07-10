// Approval-intent tests: closed-list fast path plus model-judged classification.
import { describe, expect, it, vi } from "vitest";
import {
  classifyCrestodianApprovalIntent,
  classifyCrestodianApprovalText,
} from "./approval-intent.js";

const validSnapshot = {
  exists: true,
  valid: true,
  path: "/tmp/openclaw.json",
  hash: "h",
  config: {},
  sourceConfig: {},
  runtimeConfig: {},
  issues: [],
} as never;

function completionDeps(replyText: string) {
  return {
    readConfigFileSnapshot: vi.fn(async () => validSnapshot),
    prepareSimpleCompletionModelForAgent: vi.fn(async () => ({
      model: {},
      auth: {},
      selection: { provider: "openai", modelId: "gpt-5.5" },
    })) as never,
    completeWithPreparedSimpleCompletionModel: vi.fn(async () => ({
      content: [{ type: "text", text: replyText }],
    })) as never,
  };
}

describe("classifyCrestodianApprovalText", () => {
  it("accepts natural affirmatives regardless of case and punctuation", () => {
    for (const text of ["yes", "Yes.", "sure", "ok!", "Okay,", "go ahead", "yes please", "do it"]) {
      expect(classifyCrestodianApprovalText(text)).toBe("approve");
    }
  });

  it("treats clear rejections as declines", () => {
    for (const text of ["no", "no thanks", "not now", "cancel", "don't", "nah, later"]) {
      expect(classifyCrestodianApprovalText(text)).toBe("decline");
    }
  });

  it("keeps everything ambiguous as other", () => {
    for (const text of ["maybe", "what does that change?", "yes but use gpt instead", ""]) {
      expect(classifyCrestodianApprovalText(text)).toBe("other");
    }
  });
});

describe("classifyCrestodianApprovalIntent", () => {
  it("short-circuits closed-list answers without a model call", async () => {
    const deps = completionDeps("approve");
    await expect(classifyCrestodianApprovalIntent({ message: "yes" }, deps)).resolves.toBe(
      "approve",
    );
    expect(deps.completeWithPreparedSimpleCompletionModel).not.toHaveBeenCalled();
  });

  it("asks the model for ambiguous messages and trusts a clear verdict", async () => {
    const deps = completionDeps("approve");
    await expect(
      classifyCrestodianApprovalIntent(
        { message: "alright, ship that change", proposal: "set config gateway.port to 19001" },
        deps,
      ),
    ).resolves.toBe("approve");
    expect(deps.completeWithPreparedSimpleCompletionModel).toHaveBeenCalledOnce();
  });

  it("fails closed to other on unexpected model output", async () => {
    const deps = completionDeps("I think the user probably agrees");
    await expect(
      classifyCrestodianApprovalIntent({ message: "hmm alright I guess?" }, deps),
    ).resolves.toBe("other");
  });

  it("fails closed to other when no model is usable", async () => {
    const deps = {
      ...completionDeps("approve"),
      prepareSimpleCompletionModelForAgent: vi.fn(async () => ({ error: "no model" })) as never,
    };
    await expect(classifyCrestodianApprovalIntent({ message: "alright then" }, deps)).resolves.toBe(
      "other",
    );
  });
});
