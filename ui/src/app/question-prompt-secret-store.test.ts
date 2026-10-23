// @vitest-environment node
// Store-bound questions never retain submitted credentials in terminal UI state.
import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import type { Question, QuestionRecord, QuestionResolveResult } from "@openclaw/gateway-protocol";
import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../api/gateway.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import {
  createQuestionHarness,
  questionNotFoundError,
  type RequestFn,
} from "./question-prompt.test-support.ts";
import {
  handleQuestionPromptEvent,
  refreshPendingQuestionsWithRetry,
  setQuestionPromptClient,
  submitQuestionPrompt,
} from "./question-prompt.ts";

type SecretBinding = NonNullable<Question["secretStore"]>;
const { createState } = createQuestionHarness();
const storedAnswer = {
  status: "answered",
  answers: { answers: { secret_value: ["stored"] } },
} satisfies QuestionResolveResult;

function requestedSecret(
  secretStore: SecretBinding = { name: "TEST_API_KEY", kind: "secret" },
  overrides: Partial<Question> = {},
): QuestionRecord {
  return {
    id: "question-1",
    questions: [
      {
        questionId: "secret_value",
        header: "API key",
        question: "Provide the fake test credential.",
        options: [],
        isSecret: true,
        secretStore,
        ...overrides,
      },
    ],
    agentId: "main",
    sessionKey: "agent:main:main",
    createdAtMs: 1_000,
    expiresAtMs: Date.now() + 60_000,
    status: "pending",
  };
}

function createSecretPrompt(request?: RequestFn, record = requestedSecret()) {
  const state = createState();
  const client = request ? { request } : null;
  if (client) {
    setQuestionPromptClient(state, client);
  }
  handleQuestionPromptEvent(state, { event: "question.requested", payload: record });
  const prompt = state.prompts.get(record.id);
  if (!prompt) {
    throw new Error("valid secret question was not registered");
  }
  return { state, prompt, client };
}

describe("store-bound question normalization", () => {
  it("preserves protocol-derived binding and replacement metadata", () => {
    const secretStore: SecretBinding = {
      name: "TEST_API_KEY",
      kind: "secret",
      allowedHosts: ["api.example.test"],
      reason: "The test agent needs a fake credential.",
    };
    const secretStoreExisting: NonNullable<Question["secretStoreExisting"]> = {
      updatedAtMs: 1_234,
      updatedBy: "operator@example.test",
    };
    const { prompt } = createSecretPrompt(
      undefined,
      requestedSecret(secretStore, {
        secretStoreExisting: { ...secretStoreExisting, updatedBy: " operator@example.test " },
      }),
    );

    expect(prompt.questions[0]).toMatchObject({ isSecret: true, secretStore, secretStoreExisting });
  });

  it.each([
    {
      label: "negative replacement timestamp",
      secretStoreExisting: { updatedAtMs: -1 },
    },
    {
      label: "unsafe replacement timestamp",
      secretStoreExisting: { updatedAtMs: Number.MAX_SAFE_INTEGER + 1 },
    },
    {
      label: "blank replacement writer",
      secretStoreExisting: { updatedAtMs: 1_234, updatedBy: " " },
    },
  ])("rejects $label", ({ secretStoreExisting }) => {
    const state = createState();
    const record = requestedSecret();

    expect(
      handleQuestionPromptEvent(state, {
        event: "question.requested",
        payload: { ...record, questions: [{ ...record.questions[0], secretStoreExisting }] },
      }),
    ).toBe(false);
  });
});

describe("store-bound question submission", () => {
  const secretBinding: SecretBinding = { name: "TEST_API_KEY", kind: "secret" };
  const proposedHosts = ["proposed.example.test"];
  const proposed = { ...secretBinding, allowedHosts: proposedHosts };
  it.each<[string, SecretBinding, string | undefined, string[] | undefined]>([
    ["proposed hosts", proposed, undefined, proposedHosts],
    [
      "edited hosts",
      secretBinding,
      " first.example.test, second.example.test\nthird.example.test ",
      ["first.example.test", "second.example.test", "third.example.test"],
    ],
    ["cleared hosts", proposed, "  ", []],
    ["no proposed hosts", secretBinding, undefined, undefined],
    [
      "environment ignores hosts",
      { name: "TEST_ENV_VALUE", kind: "env" },
      "ignored.example.test",
      undefined,
    ],
  ])("submits %s", async (_label, binding, draft, expectedHosts) => {
    const request = vi.fn<RequestFn>(async () => storedAnswer);
    const { state, prompt } = createSecretPrompt(request, requestedSecret(binding));
    if (draft !== undefined) {
      prompt.secretStoreAllowedHostsDraft = draft;
    }

    await submitQuestionPrompt(state, prompt.id, { secret_value: ["fake-secret-test-value"] });

    expect(request).toHaveBeenCalledWith(
      "question.resolve",
      {
        id: prompt.id,
        answers: { answers: { secret_value: ["fake-secret-test-value"] } },
        ...(expectedHosts !== undefined ? { secretStoreAllowedHosts: expectedHosts } : {}),
      },
      { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
    );
    expect(prompt.submittedAnswers).toEqual(storedAnswer.answers);
  });

  it("preserves a secret draft on validation failure and clears it after successful retry", async () => {
    const fakeSecret = "fake-secret-retry-test-value";
    const request = vi
      .fn<RequestFn>()
      .mockRejectedValueOnce(
        new GatewayRequestError({ code: "INVALID_REQUEST", message: "Allowed host is invalid." }),
      )
      .mockResolvedValueOnce(storedAnswer);
    const { state, prompt } = createSecretPrompt(request);
    prompt.drafts.set("secret_value", { selected: new Set(), freeText: fakeSecret });

    await submitQuestionPrompt(state, prompt.id, { secret_value: [fakeSecret] });

    expect(prompt).toMatchObject({
      status: "pending",
      submitting: false,
      error: "Allowed host is invalid.",
      submittedAnswers: storedAnswer.answers,
    });
    expect(prompt.drafts.get("secret_value")?.freeText).toBe(fakeSecret);

    await submitQuestionPrompt(state, prompt.id, { secret_value: [fakeSecret] });

    expect(prompt).toMatchObject({
      status: "answered",
      answers: storedAnswer.answers,
      submittedAnswers: storedAnswer.answers,
    });
    expect(prompt.drafts.has("secret_value")).toBe(false);
  });
});

describe("store-bound question terminal cleanup", () => {
  it("forgets the secret draft when the local deadline expires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T00:00:00.000Z"));
    const record = requestedSecret();
    record.expiresAtMs = Date.now() + 1_000;
    const { prompt } = createSecretPrompt(undefined, record);
    prompt.drafts.set("secret_value", {
      selected: new Set(),
      freeText: "fake-secret-expired-test-value",
    });

    vi.advanceTimersByTime(1_000);

    expect(prompt.status).toBe("expired");
    expect(prompt.drafts.has("secret_value")).toBe(false);
  });

  it("forgets the secret draft when recovery proves the question unavailable", async () => {
    const request = vi.fn<RequestFn>(async (method) => {
      if (method === "question.list") {
        return { questions: [] };
      }
      throw questionNotFoundError();
    });
    const { state, prompt, client } = createSecretPrompt(request);
    prompt.drafts.set("secret_value", {
      selected: new Set(),
      freeText: "fake-secret-unavailable-test-value",
    });
    if (!client) {
      throw new Error("connected secret question has no client");
    }

    refreshPendingQuestionsWithRetry(state, client);
    await waitForFast(() => expect(prompt.status).toBe("unavailable"));

    expect(prompt.drafts.has("secret_value")).toBe(false);
  });
});
