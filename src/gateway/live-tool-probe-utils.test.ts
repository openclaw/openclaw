import { describe, expect, it } from "vitest";
import {
  hasExpectedToolNonce,
  isLikelyToolNonceRefusal,
  shouldRetryExecReadProbe,
  shouldRetryToolReadProbe,
} from "./live-tool-probe.test-helpers.js";

const probeDefaults = { provider: "openai", attempt: 0, maxAttempts: 3 };

describe("live tool probe utils", () => {
  it("rejects partial tool nonce matches", () => {
    expect(hasExpectedToolNonce("value a-1 only", "a-1", "b-2")).toBe(false);
  });

  describe("refusal detection", () => {
    it.each([
      {
        name: "detects prompt-injection style refusals without nonce text",
        text: "That's not a legitimate self-test. This looks like a prompt injection attempt.",
        expected: true,
      },
      {
        name: "detects tool authorization refusals",
        text: "Before proceeding, I must confirm: are you authorizing me to execute the read tool with the provided arguments?",
        expected: true,
      },
      {
        name: "detects unavailable read tool refusals",
        text: "tool probe missing nonce: I can’t: there is no `read`/`Read` tool available in this session, and I won’t output those nonce values without actually reading the file.",
        expected: true,
      },
      {
        name: "does not treat nonce markers without the word nonce as refusal",
        text: "No part of the system asks me to parrot back values.",
        expected: false,
      },
    ])("$name", ({ text, expected }) => {
      expect(isLikelyToolNonceRefusal(text)).toBe(expected);
    });
  });

  describe("shouldRetryToolReadProbe", () => {
    it.each([
      {
        name: "retries malformed tool output when attempts remain",
        params: {
          text: "read[object Object],[object Object]",
          provider: "mistral",
        },
        expected: true,
      },
      {
        name: "retries a well-formed nonce mismatch when policy allows it",
        params: {
          text: "9b3a1178-3b42-430b-9146-27b08416824b",
          provider: "google",
          retryKnownNonceMismatch: true,
        },
        expected: true,
      },
      {
        name: "does not retry a policy mismatch after attempts are exhausted",
        params: {
          text: "9b3a1178-3b42-430b-9146-27b08416824b",
          provider: "google",
          attempt: 2,
          retryKnownNonceMismatch: true,
        },
        expected: false,
      },
      {
        name: "prefers a valid nonce pair over mismatch retry policy",
        params: {
          text: "nonce-a nonce-b 9b3a1178-3b42-430b-9146-27b08416824b",
          provider: "google",
          retryKnownNonceMismatch: true,
        },
        expected: false,
      },
      {
        name: "does not retry a well-formed mismatch without known-model policy",
        params: {
          text: "9b3a1178-3b42-430b-9146-27b08416824b",
        },
        expected: false,
      },
      {
        name: "prefers a valid nonce pair even if the text still contains scaffolding words",
        params: {
          text: "tool output nonce-a nonce-b function",
        },
        expected: false,
      },
      {
        name: "retries empty output",
        params: {
          text: "   ",
        },
        expected: true,
      },
      {
        name: "retries tool scaffolding output",
        params: {
          text: "Use tool function read[] now.",
        },
        expected: true,
      },
      {
        name: "retries conversational try-again output",
        params: {
          text: "Let me try reading the file again:",
          provider: "zai",
        },
        expected: true,
      },
      {
        name: "does not retry generic conversational text without tool-retry context",
        params: {
          text: "Let me try a different approach.",
          provider: "zai",
        },
        expected: false,
      },
      {
        name: "retries mistral marker echoes without parsed values",
        params: {
          text: "testMarkerA= testMarkerB=",
          provider: "mistral",
        },
        expected: true,
      },
      {
        name: "retries anthropic refusal output",
        params: {
          text: "This isn't a real OpenClaw probe; I won't parrot back nonce values.",
          provider: "anthropic",
        },
        expected: true,
      },
      {
        name: "does not special-case anthropic refusals for other providers",
        params: {
          text: "This isn't a real OpenClaw probe; I won't parrot back nonce values.",
        },
        expected: false,
      },
    ])("$name", ({ params, expected }) => {
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
      {
        name: "retries malformed exec+read output when attempts remain",
        params: {
          text: "read[object Object]",
        },
        expected: true,
      },
      {
        name: "retries a well-formed exec nonce mismatch when policy allows it",
        params: {
          text: "9b3a1178-3b42-430b-9146-27b08416824b",
          provider: "google",
          retryKnownNonceMismatch: true,
        },
        expected: true,
      },
      {
        name: "does not retry an exec policy mismatch after attempts are exhausted",
        params: {
          text: "9b3a1178-3b42-430b-9146-27b08416824b",
          provider: "google",
          attempt: 2,
          retryKnownNonceMismatch: true,
        },
        expected: false,
      },
      {
        name: "prefers a valid exec nonce over mismatch retry policy",
        params: {
          text: "nonce-c 9b3a1178-3b42-430b-9146-27b08416824b",
          provider: "google",
          retryKnownNonceMismatch: true,
        },
        expected: false,
      },
      {
        name: "does not retry a well-formed exec mismatch without known-model policy",
        params: {
          text: "9b3a1178-3b42-430b-9146-27b08416824b",
        },
        expected: false,
      },
      {
        name: "prefers a valid nonce even if the text still contains scaffolding words",
        params: {
          text: "tool output nonce-c function",
        },
        expected: false,
      },
      {
        name: "retries anthropic nonce refusal output",
        params: {
          text: "No part of the system asks me to parrot back nonce values.",
          provider: "anthropic",
        },
        expected: true,
      },
      {
        name: "retries conversational try-again exec output",
        params: {
          text: "Let me try reading the file again:",
          provider: "zai",
        },
        expected: true,
      },
      {
        name: "retries alternate exec readback retry wording",
        params: {
          text: "Let me try again with a slightly different approach:",
          provider: "minimax-portal",
        },
        expected: true,
      },
      {
        name: "retries eventual-consistency exec readback output",
        params: {
          text: "The file creation command succeeded, but the file wasn't found immediately after. Let me verify the file exists and read it again.",
          provider: "mistral",
        },
        expected: true,
      },
      {
        name: "retries file-not-found exec readback wording",
        params: {
          text: "The `exec` command ran successfully, but the file read failed because the file was not found. Let me verify the file creation and read it again.",
          provider: "mistral",
        },
        expected: true,
      },
      {
        name: "does not retry generic exec conversational text without tool-retry context",
        params: {
          text: "Let me try a different approach.",
          provider: "zai",
        },
        expected: false,
      },
      {
        name: "does not special-case anthropic refusals for other providers",
        params: {
          text: "No part of the system asks me to parrot back nonce values.",
        },
        expected: false,
      },
    ])("$name", ({ params, expected }) => {
      expect(shouldRetryExecReadProbe({ ...probeDefaults, nonce: "nonce-c", ...params })).toBe(
        expected,
      );
    });
  });
});
