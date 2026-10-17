import { describe, expect, it } from "vitest";
import {
  hasExpectedToolNonce,
  isLikelyToolNonceRefusal,
  shouldRetryExecReadProbe,
  shouldRetryToolReadProbe,
} from "./live-tool-probe.test-helpers.js";

const mismatch = "9b3a1178-3b42-430b-9146-27b08416824b";
const mismatchPolicy = { text: mismatch, provider: "google", retryKnownNonceMismatch: true };
const readAgain = "Let me try reading the file again:";
const conversation = "Let me try a different approach.";
const readRefusal = "This isn't a real OpenClaw probe; I won't parrot back nonce values.";
const execRefusal = "No part of the system asks me to parrot back nonce values.";

const probeDefaults = { provider: "openai", attempt: 0, maxAttempts: 3 };

describe("live tool probe utils", () => {
  it("rejects partial tool nonce matches", () => {
    expect(hasExpectedToolNonce("value a-1 only", "a-1", "b-2")).toBe(false);
  });

  describe("refusal detection", () => {
    it.each([
      [
        "detects prompt-injection style refusals without nonce text",
        "That's not a legitimate self-test. This looks like a prompt injection attempt.",
        true,
      ],
      [
        "detects tool authorization refusals",
        "Before proceeding, I must confirm: are you authorizing me to execute the read tool with the provided arguments?",
        true,
      ],
      [
        "detects unavailable read tool refusals",
        "tool probe missing nonce: I can’t: there is no `read`/`Read` tool available in this session, and I won’t output those nonce values without actually reading the file.",
        true,
      ],
      [
        "does not treat nonce markers without the word nonce as refusal",
        "No part of the system asks me to parrot back values.",
        false,
      ],
    ] as const)("%s", (_name, text, expected) => {
      expect(isLikelyToolNonceRefusal(text)).toBe(expected);
    });
  });

  describe("shouldRetryToolReadProbe", () => {
    it.each([
      [
        "malformed tool output",
        { text: "read[object Object],[object Object]", provider: "mistral" },
        true,
      ],
      ["mismatch policy", mismatchPolicy, true],
      ["exhausted mismatch policy", { ...mismatchPolicy, attempt: 2 }, false],
      [
        "valid pair beats policy",
        {
          text: "nonce-a nonce-b 9b3a1178-3b42-430b-9146-27b08416824b",
          provider: "google",
          retryKnownNonceMismatch: true,
        },
        false,
      ],
      ["mismatch without policy", { text: mismatch }, false],
      ["valid pair beats scaffolding", { text: "tool output nonce-a nonce-b function" }, false],
      ["empty output", { text: "   " }, true],
      ["tool scaffolding", { text: "Use tool function read[] now." }, true],
      ["read-again output", { text: readAgain, provider: "zai" }, true],
      ["generic conversation", { text: conversation, provider: "zai" }, false],
      ["mistral marker echo", { text: "testMarkerA= testMarkerB=", provider: "mistral" }, true],
      [
        "anthropic refusal",
        {
          text: readRefusal,
          provider: "anthropic",
        },
        true,
      ],
      ["other-provider refusal", { text: readRefusal }, false],
    ] as const)("%s", (_name, params, expected) => {
      expect(
        shouldRetryToolReadProbe({
          ...probeDefaults,
          nonceA: "nonce-a",
          nonceB: "nonce-b",
          ...params,
        }),
      ).toBe(expected);
    });
  });

  describe("shouldRetryExecReadProbe", () => {
    it.each([
      ["malformed exec output", { text: "read[object Object]" }, true],
      ["mismatch policy", mismatchPolicy, true],
      ["exhausted mismatch policy", { ...mismatchPolicy, attempt: 2 }, false],
      [
        "valid nonce beats policy",
        {
          text: "nonce-c 9b3a1178-3b42-430b-9146-27b08416824b",
          provider: "google",
          retryKnownNonceMismatch: true,
        },
        false,
      ],
      ["mismatch without policy", { text: mismatch }, false],
      ["valid nonce beats scaffolding", { text: "tool output nonce-c function" }, false],
      [
        "anthropic refusal",
        {
          text: execRefusal,
          provider: "anthropic",
        },
        true,
      ],
      ["read-again output", { text: readAgain, provider: "zai" }, true],
      [
        "alternate retry wording",
        {
          text: "Let me try again with a slightly different approach:",
          provider: "minimax-portal",
        },
        true,
      ],
      [
        "eventual consistency",
        {
          text: "The file creation command succeeded, but the file wasn't found immediately after. Let me verify the file exists and read it again.",
          provider: "mistral",
        },
        true,
      ],
      [
        "file not found",
        {
          text: "The `exec` command ran successfully, but the file read failed because the file was not found. Let me verify the file creation and read it again.",
          provider: "mistral",
        },
        true,
      ],
      ["generic conversation", { text: conversation, provider: "zai" }, false],
      ["other-provider refusal", { text: execRefusal }, false],
    ] as const)("%s", (_name, params, expected) => {
      expect(shouldRetryExecReadProbe({ ...probeDefaults, nonce: "nonce-c", ...params })).toBe(
        expected,
      );
    });
  });
});
