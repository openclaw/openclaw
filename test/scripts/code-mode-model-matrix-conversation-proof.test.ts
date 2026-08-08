import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CODE_MODE_CONVERSATION_PROOF_PROMPT,
  codeModeConversationProofTesting,
  type CodeModeConversationProofPolicy,
} from "../../scripts/lib/code-mode-model-matrix-conversation-proof.js";
import {
  createFrontierCodeModeCapabilityReceiptFixture,
  createValidConversationProofSummaryFixture,
  createValidRawConversationProofSummaryFixture,
} from "../../scripts/lib/code-mode-model-matrix-conversation-proof.test-support.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";

type ProofSummary = ReturnType<typeof createValidConversationProofSummaryFixture>;
type RawProofSummary = ReturnType<typeof createValidRawConversationProofSummaryFixture>;
type ProofCell = Record<string, unknown> & {
  id: "Code-exact" | "Code-ambiguous" | "Code-incomplete";
  passed: boolean;
  scenario: "exact" | "ambiguous" | "incomplete";
};
type RuntimeIdentity = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
};

function clonePublicSummary(): ProofSummary {
  return structuredClone(createValidConversationProofSummaryFixture({ gitSha: "abc123" }));
}

function cloneRawSummary(): RawProofSummary {
  return structuredClone(createValidRawConversationProofSummaryFixture({ gitSha: "abc123" }));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function cells(summary: ProofSummary | RawProofSummary): ProofCell[] {
  return summary.cells as ProofCell[];
}

function nestedCalls(cell: Record<string, unknown>): Array<Record<string, unknown>> {
  return cell.nestedCalls as Array<Record<string, unknown>>;
}

function transcriptFromCell(cell: Record<string, unknown>, sessionId: string) {
  return {
    authoredMethods: cell.authoredMethods as string[],
    callCount: cell.executedNestedToolCalls as number,
    completedExecResultCount: cell.completedOuterExecResults as number,
    attemptedToolNames: cell.attemptedToolNames as string[],
    attemptedToolNamesTruncated: cell.attemptedToolNamesTruncated as boolean,
    execCallCount: cell.outerExecCalls as number,
    execSource: cell.execSource as string,
    finalText: cell.finalText as string,
    isError: false,
    nestedCalls: cell.nestedCalls as Array<{
      input: unknown;
      name: "conversations_list" | "conversations_send";
      result: unknown;
    }>,
    sessionId,
    value: cell.value,
  };
}

function conversationProofSnapshots(cell: Record<string, unknown>) {
  let reads = 0;
  return () => ({
    messages:
      reads++ === 0
        ? []
        : (cell.outboundMessages as Array<{
            accountId: string;
            id: string;
            conversation: { id: string; kind: string };
            direction: string;
            text: string;
            threadId?: string;
          }>),
  });
}

function executionPolicy(
  overrides: Partial<CodeModeConversationProofPolicy> = {},
): CodeModeConversationProofPolicy {
  return {
    api: "openai-responses",
    authMode: "api_key",
    authBindingId: "1".repeat(32),
    cachePolicy: {
      build: "shared_immutable",
      os: "uncontrolled",
      provider: "uncontrolled",
    },
    candidateRuntime: "embedded",
    codeModeActivation: "explicit_frozen_run_config",
    codeModeCapability: createFrontierCodeModeCapabilityReceiptFixture(),
    concurrency: 1,
    credentialEnvName: "OPENAI_API_KEY",
    defaultAgentId: "main",
    endpoint: "https://api.openai.com/v1",
    environmentPolicySha256: "2".repeat(64),
    fallbacks: "disabled",
    harnessRetries: 0,
    model: "openai/gpt-5.6",
    processState: "fresh_per_cell",
    provider: "openai",
    providerRetryPolicy: "openai-responses-runtime-default",
    runtime: "openclaw",
    schedule: "serial_abba",
    seed: "unsupported_unset",
    selectorSource: "config",
    thinking: "high",
    ...overrides,
  };
}

describe("Code Mode matrix conversation proof", () => {
  it("keeps explicit OpenClaw framing and positive one-cell JS/TS guidance", () => {
    expect(CODE_MODE_CONVERSATION_PROOF_PROMPT).toContain("OpenClaw Code Mode");
    expect(CODE_MODE_CONVERSATION_PROOF_PROMPT).toContain("JavaScript or TypeScript");
    expect(CODE_MODE_CONVERSATION_PROOF_PROMPT).toContain("one deterministic");
    expect(CODE_MODE_CONVERSATION_PROOF_PROMPT).toContain("all five requested tuple fields");
    expect(CODE_MODE_CONVERSATION_PROOF_PROMPT).toContain(
      "raw conversations_send result in sendResult",
    );
    expect(CODE_MODE_CONVERSATION_PROOF_PROMPT).toContain("labels are display-only");
    expect(CODE_MODE_CONVERSATION_PROOF_PROMPT).toContain("limit: 100");
    expect(CODE_MODE_CONVERSATION_PROOF_PROMPT).toContain("final answer exactly SENT");
    expect(CODE_MODE_CONVERSATION_PROOF_PROMPT).toContain("AMBIGUOUS_NO_SEND");
    expect(CODE_MODE_CONVERSATION_PROOF_PROMPT).toContain("INCOMPLETE_NO_SEND");
  });

  it("counts only authored tool calls from parsed JS/TS", async () => {
    expect(
      codeModeConversationProofTesting.readAuthoredMethods(`
        const label = "tools.conversations_send()";
        const listed = await tools.conversations_list({ query: "Build bot" });
        if (listed.conversations.length === 1) {
          await tools.conversations_send({
            conversationRef: listed.conversations[0].conversationRef,
            message: "Build finished.",
          });
        }
      `),
    ).toEqual(["conversations_list", "conversations_send"]);
  });

  it("accepts structured and serialized exec inputs", () => {
    expect(
      codeModeConversationProofTesting.readToolCallInput({
        arguments: { language: "typescript", code: "return 1" },
      }),
    ).toEqual({ language: "typescript", code: "return 1" });
    expect(
      codeModeConversationProofTesting.readToolCallInput({
        arguments: '{"language":"javascript","code":"return 2"}',
      }),
    ).toEqual({ language: "javascript", code: "return 2" });
  });

  it("deep-validates exact, ambiguous, and incomplete raw traces", () => {
    const rawSummary = cloneRawSummary();
    const expected = {
      buildSha256: rawSummary.buildSha256 as string,
      configSha256: rawSummary.configSha256 as string,
      executionPolicy: executionPolicy(),
      gitSha: "abc123",
      model: "openai/gpt-5.6",
    };

    expect(
      codeModeConversationProofTesting.validateRawCodeModeConversationProofSummary(
        rawSummary,
        expected,
      ),
    ).toEqual({ valid: true });
    expect(cells(rawSummary).map((cell) => cell.id)).toEqual([
      "Code-exact",
      "Code-ambiguous",
      "Code-incomplete",
    ]);
    expect(cells(rawSummary).map((cell) => cell.executedNestedToolCalls)).toEqual([2, 1, 1]);
    expect(cells(rawSummary).map((cell) => cell.outboundMessageDelta)).toEqual([1, 0, 0]);
    expect(cells(rawSummary)[2]).toMatchObject({
      resultComplete: false,
      globalOutboundMessageDelta: 1,
      globalOutboundValid: true,
    });

    const publicSummary = clonePublicSummary();
    expect(
      codeModeConversationProofTesting.validateCodeModeConversationProofSummary(
        publicSummary,
        expected,
      ),
    ).toEqual({ valid: true });
  });

  it("requires one isolated scenario owner per cell and preserves all diagnostics after failure", async () => {
    const valid = cloneRawSummary();
    const validCells = cells(valid);
    const observed: string[] = [];
    const complete = await codeModeConversationProofTesting.runConversationProofCells({
      runScenario: async (definition: { id: string }, ordinal: number) => {
        observed.push(`${definition.id}:${ordinal}`);
        return structuredClone(validCells[ordinal - 1]!);
      },
    });

    expect(observed).toEqual(["Code-exact:1", "Code-ambiguous:2", "Code-incomplete:3"]);
    expect(complete).toHaveLength(3);
    expect(complete[2]).toMatchObject({
      globalOutboundMessageDelta: 1,
      globalOutboundValid: true,
      passed: true,
    });

    observed.length = 0;
    const failed = await codeModeConversationProofTesting.runConversationProofCells({
      runScenario: async (definition: { id: string }, ordinal: number) => {
        observed.push(`${definition.id}:${ordinal}`);
        return ordinal === 2
          ? { ...structuredClone(validCells[1]!), passed: false }
          : structuredClone(validCells[ordinal - 1]!);
      },
    });
    expect(failed).toHaveLength(3);
    expect(observed).toEqual(["Code-exact:1", "Code-ambiguous:2", "Code-incomplete:3"]);
    expect(failed[1]).toMatchObject({ passed: false });
  });

  it("binds a passing cell to the runtime identity returned by agent.wait", async () => {
    const exactCell = cells(cloneRawSummary())[0] as Record<string, unknown>;
    const runtimeIdentity = {
      agentId: "main",
      sessionId: "session-runtime",
      sessionKey: "agent:main:code-mode-conversation-code-exact",
    };
    const readTranscript = vi.fn(async (identity: RuntimeIdentity) =>
      transcriptFromCell(exactCell, identity.sessionId),
    );

    const result = await codeModeConversationProofTesting.runConversationProofCell({
      agentId: "main",
      callGateway: async (method: string) =>
        method === "agent" ? { runId: "run-runtime" } : { status: "ok", ...runtimeIdentity },
      gatewayPidSha256: sha256("gateway-runtime"),
      getSnapshot: conversationProofSnapshots(exactCell),
      ordinal: 1,
      readTranscript,
      registryRows: exactCell.registeredRows as never,
      scenario: "exact",
      thinking: "high",
      uuid: () => "idempotency-runtime",
    });

    expect(readTranscript).toHaveBeenCalledWith(runtimeIdentity);
    expect(result).toMatchObject({
      passed: true,
      agentIdSha256: sha256(runtimeIdentity.agentId),
      sessionIdSha256: sha256(runtimeIdentity.sessionId),
      sessionKeySha256: sha256(runtimeIdentity.sessionKey),
    });
  });

  it("looks up the observed route before rejecting a runtime identity mismatch", async () => {
    const exactCell = cells(cloneRawSummary())[0] as Record<string, unknown>;
    const observedIdentity = {
      agentId: "foreign",
      sessionId: "session-foreign",
      sessionKey: "agent:foreign:code-mode-conversation-code-exact",
    };
    const readTranscript = vi.fn(async (identity: RuntimeIdentity) =>
      transcriptFromCell(exactCell, identity.sessionId),
    );

    const result = await codeModeConversationProofTesting.runConversationProofCell({
      agentId: "main",
      callGateway: async (method: string) =>
        method === "agent" ? { runId: "run-foreign" } : { status: "ok", ...observedIdentity },
      gatewayPidSha256: sha256("gateway-foreign"),
      getSnapshot: conversationProofSnapshots(exactCell),
      ordinal: 1,
      readTranscript,
      registryRows: exactCell.registeredRows as never,
      scenario: "exact",
      thinking: "high",
      uuid: () => "idempotency-foreign",
    });

    expect(readTranscript).toHaveBeenCalledWith(observedIdentity);
    expect(result).toMatchObject({
      passed: false,
      failureCode: "conversation_proof_runtime_identity_mismatch",
      agentIdSha256: sha256(observedIdentity.agentId),
      sessionIdSha256: sha256(observedIdentity.sessionId),
      sessionKeySha256: sha256(observedIdentity.sessionKey),
    });
  });

  it("fails closed when agent.wait omits the runtime identity", async () => {
    const exactCell = cells(cloneRawSummary())[0] as Record<string, unknown>;
    const readTranscript = vi.fn();

    const result = await codeModeConversationProofTesting.runConversationProofCell({
      agentId: "main",
      callGateway: async (method: string) =>
        method === "agent" ? { runId: "run-missing" } : { status: "ok" },
      gatewayPidSha256: sha256("gateway-missing"),
      getSnapshot: conversationProofSnapshots(exactCell),
      ordinal: 1,
      readTranscript,
      registryRows: exactCell.registeredRows as never,
      scenario: "exact",
      thinking: "high",
      uuid: () => "idempotency-missing",
    });

    expect(readTranscript).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      passed: false,
      failureCode: "conversation_proof_runtime_identity_missing",
    });
    expect(result).not.toHaveProperty("agentIdSha256");
    expect(result).not.toHaveProperty("sessionIdSha256");
    expect(result).not.toHaveProperty("sessionKeySha256");
  });

  it("rejects a transcript from a foreign session before evaluating the cell", async () => {
    const exactCell = cells(cloneRawSummary())[0] as Record<string, unknown>;
    const runtimeIdentity = {
      agentId: "main",
      sessionId: "session-runtime",
      sessionKey: "agent:main:code-mode-conversation-code-exact",
    };

    const result = await codeModeConversationProofTesting.runConversationProofCell({
      agentId: "main",
      callGateway: async (method: string) =>
        method === "agent"
          ? { runId: "run-foreign-session" }
          : { status: "ok", ...runtimeIdentity },
      gatewayPidSha256: sha256("gateway-foreign-session"),
      getSnapshot: conversationProofSnapshots(exactCell),
      ordinal: 1,
      readTranscript: async () => transcriptFromCell(exactCell, "session-foreign"),
      registryRows: exactCell.registeredRows as never,
      scenario: "exact",
      thinking: "high",
      uuid: () => "idempotency-foreign-session",
    });

    expect(result).toMatchObject({
      passed: false,
      failureCode: "conversation_proof_transcript_identity_mismatch",
      sessionIdSha256: sha256(runtimeIdentity.sessionId),
    });
  });

  it("keeps scenario registries isolated in distinct state roots", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-proof-registry-"));
    try {
      const rows = (["exact", "ambiguous", "incomplete"] as const).map((scenario) =>
        codeModeConversationProofTesting.registerConversationProofScenario({
          registryScope: {
            agentId: "qa",
            env: { OPENCLAW_STATE_DIR: path.join(root, scenario) },
          },
          scenario,
        }),
      );

      expect(rows.map((entries) => entries.length)).toEqual([6, 7, 101]);
      const exactMatch = {
        channel: "qa-channel",
        accountId: "default",
        kind: "direct",
        target: "dm:build-bot",
        threadId: null,
      };
      expect(rows[0]![0]).not.toMatchObject(exactMatch);
      expect(rows[0]!.at(-1)).not.toMatchObject(exactMatch);
      const exactMatchIndex = rows[0]!.findIndex((entry) =>
        Object.entries(exactMatch).every(
          ([key, value]) => entry[key as keyof typeof entry] === value,
        ),
      );
      expect(exactMatchIndex).toBeGreaterThan(0);
      expect(exactMatchIndex).toBeLessThan(rows[0]!.length - 1);
      expect(rows[0]!.some((entry) => entry.accountId === "incomplete-omitted")).toBe(false);
      expect(
        rows[1]!.filter(
          (entry) =>
            entry.channel === "qa-channel" &&
            entry.accountId === "default" &&
            entry.kind === "direct" &&
            entry.target === "dm:build-bot" &&
            entry.threadId === null,
        ),
      ).toHaveLength(2);
      expect(rows[2]!.some((entry) => entry.accountId === "incomplete-omitted")).toBe(true);
    } finally {
      await fs.rm(root, { force: true, recursive: true });
    }
  });

  it.each([
    {
      name: "blind exact selection of the first listed row",
      mutate(summary: RawProofSummary) {
        const cell = cells(summary)[0]!;
        const listed = (
          nestedCalls(cell)[0]!.result as { conversations: Array<Record<string, unknown>> }
        ).conversations;
        nestedCalls(cell)[1]!.input = {
          conversationRef: listed[0]!.conversationRef,
          message: "Build finished.",
        };
      },
    },
    {
      name: "blind exact selection of the last listed row",
      mutate(summary: RawProofSummary) {
        const cell = cells(summary)[0]!;
        const listed = (
          nestedCalls(cell)[0]!.result as { conversations: Array<Record<string, unknown>> }
        ).conversations;
        nestedCalls(cell)[1]!.input = {
          conversationRef: listed.at(-1)!.conversationRef,
          message: "Build finished.",
        };
      },
    },
    {
      name: "channel-filtered list input",
      mutate(summary: RawProofSummary) {
        nestedCalls(cells(summary)[0]!)[0]!.input = {
          channel: "qa-channel",
          query: "dm:build-bot",
          limit: 100,
        };
      },
    },
    {
      name: "missing channel decoy",
      mutate(summary: RawProofSummary) {
        const call = nestedCalls(cells(summary)[0]!)[0]!;
        const result = call.result as { conversations: Array<Record<string, unknown>> };
        result.conversations = result.conversations.filter(
          (row) => row.channel !== "qa-channel-shadow",
        );
      },
    },
    {
      name: "reversed ambiguous candidates",
      mutate(summary: RawProofSummary) {
        const value = cells(summary)[1]!.value as {
          candidates: Array<Record<string, unknown>>;
        };
        value.candidates.reverse();
      },
    },
    {
      name: "reversed ambiguous final rows",
      mutate(summary: RawProofSummary) {
        const cell = cells(summary)[1]!;
        const [header, ...rows] = String(cell.finalText).split("\n");
        cell.finalText = [header, ...rows.toReversed()].join("\n");
      },
    },
    {
      name: "forged exact final",
      mutate(summary: RawProofSummary) {
        cells(summary)[0]!.finalText = "sent successfully";
      },
    },
    {
      name: "forged raw send receipt",
      mutate(summary: RawProofSummary) {
        const value = cells(summary)[0]!.value as {
          sendResult: Record<string, unknown>;
        };
        value.sendResult.messageId = "wrong";
      },
    },
    {
      name: "missing exact requested tuple",
      mutate(summary: RawProofSummary) {
        delete (cells(summary)[0]!.value as Record<string, unknown>).requested;
      },
    },
    {
      name: "extra exact requested tuple field",
      mutate(summary: RawProofSummary) {
        const value = cells(summary)[0]!.value as {
          requested: Record<string, unknown>;
        };
        value.requested.label = "display-only";
      },
    },
    {
      name: "forged exact completeness",
      mutate(summary: RawProofSummary) {
        (cells(summary)[0]!.value as Record<string, unknown>).resultComplete = false;
      },
    },
    {
      name: "missing exact candidates",
      mutate(summary: RawProofSummary) {
        delete (cells(summary)[0]!.value as Record<string, unknown>).candidates;
      },
    },
    {
      name: "extra returned envelope field",
      mutate(summary: RawProofSummary) {
        (cells(summary)[0]!.value as Record<string, unknown>).diagnostic = true;
      },
    },
    {
      name: "extra returned candidate field",
      mutate(summary: RawProofSummary) {
        const value = cells(summary)[0]!.value as {
          candidates: Array<Record<string, unknown>>;
        };
        value.candidates[0]!.label = "display-only";
      },
    },
    {
      name: "unexpected ambiguous send result",
      mutate(summary: RawProofSummary) {
        (cells(summary)[1]!.value as Record<string, unknown>).sendResult = {
          status: "sent",
        };
      },
    },
    {
      name: "duplicate listed row",
      mutate(summary: RawProofSummary) {
        const call = nestedCalls(cells(summary)[0]!)[0]!;
        const result = call.result as { conversations: Array<Record<string, unknown>> };
        result.conversations.push(structuredClone(result.conversations[0]!));
      },
    },
    {
      name: "incomplete registry with only 100 rows",
      mutate(summary: RawProofSummary) {
        const cell = cells(summary)[2]!;
        (cell.registeredRows as unknown[]).pop();
      },
    },
    {
      name: "truncated attempted-tool telemetry",
      mutate(summary: RawProofSummary) {
        cells(summary)[0]!.attemptedToolNamesTruncated = true;
      },
    },
    {
      name: "exec source drift",
      mutate(summary: RawProofSummary) {
        cells(summary)[0]!.execSource = "return { forged: true };";
      },
    },
    {
      name: "reused gateway process",
      mutate(summary: RawProofSummary) {
        cells(summary)[1]!.gatewayPidSha256 = cells(summary)[0]!.gatewayPidSha256;
      },
    },
    {
      name: "gateway binding drift",
      mutate(summary: RawProofSummary) {
        cells(summary)[1]!.gatewayConfigSha256 = "0".repeat(64);
      },
    },
    {
      name: "reused gateway temp root",
      mutate(summary: RawProofSummary) {
        cells(summary)[1]!.gatewayTempRootSha256 = cells(summary)[0]!.gatewayTempRootSha256;
      },
    },
    {
      name: "cell cleanup failure",
      mutate(summary: RawProofSummary) {
        cells(summary)[2]!.cleanup = { status: "failed" };
      },
    },
    {
      name: "wrong cell agent",
      mutate(summary: RawProofSummary) {
        cells(summary)[1]!.agentIdSha256 = sha256("qa");
      },
    },
    {
      name: "forged session key binding",
      mutate(summary: RawProofSummary) {
        cells(summary)[1]!.sessionKeySha256 = "0".repeat(64);
      },
    },
    {
      name: "forged summary session key list",
      mutate(summary: RawProofSummary) {
        summary.sessionKeySha256s[1] = "0".repeat(64);
      },
    },
    {
      name: "false distinct session key claim",
      mutate(summary: RawProofSummary) {
        summary.distinctSessionKeys = false;
      },
    },
    {
      name: "dirty source",
      mutate(summary: RawProofSummary) {
        summary.sourceDirty = true;
      },
    },
  ])("rejects $name", (testCase) => {
    const summary = cloneRawSummary();
    testCase.mutate(summary);
    expect(
      codeModeConversationProofTesting.validateRawCodeModeConversationProofSummary(summary, {
        buildSha256: summary.buildSha256 as string,
        configSha256: summary.configSha256 as string,
        executionPolicy: executionPolicy(),
        gitSha: "abc123",
        model: "openai/gpt-5.6",
      }).valid,
    ).toBe(false);
  });

  it("accepts display metadata on source list rows but not returned candidates", () => {
    const summary = cloneRawSummary();
    for (const cell of cells(summary)) {
      const result = nestedCalls(cell)[0]!.result as {
        conversations: Array<Record<string, unknown>>;
      };
      result.conversations = result.conversations.map((row, index) =>
        Object.assign({}, row, { label: `Display row ${index}` }),
      );
    }

    expect(
      codeModeConversationProofTesting.validateRawCodeModeConversationProofSummary(summary, {
        buildSha256: summary.buildSha256,
        configSha256: summary.configSha256,
        executionPolicy: executionPolicy(),
        gitSha: "abc123",
        model: "openai/gpt-5.6",
      }),
    ).toEqual({ valid: true });
  });

  it("rejects a proof from a different matrix build, config, model, or policy", () => {
    const summary = clonePublicSummary();
    const baseExpected = {
      buildSha256: summary.buildSha256 as string,
      configSha256: summary.configSha256 as string,
      executionPolicy: executionPolicy(),
      gitSha: "abc123",
      model: "openai/gpt-5.6",
    };

    for (const expected of [
      { ...baseExpected, buildSha256: "0".repeat(64) },
      { ...baseExpected, configSha256: "0".repeat(64) },
      { ...baseExpected, model: "openai/gpt-other" },
      {
        ...baseExpected,
        executionPolicy: executionPolicy({ authBindingId: "3".repeat(32) }),
      },
    ]) {
      expect(
        codeModeConversationProofTesting.validateCodeModeConversationProofSummary(summary, expected)
          .valid,
      ).toBe(false);
    }
  });

  it("rejects a self-consistent proof for an unsupported frontier model", () => {
    const unsupportedPolicy = executionPolicy({ model: "openai/gpt-unsupported" });
    const summary = createValidConversationProofSummaryFixture({
      executionPolicy: unsupportedPolicy,
      gitSha: "abc123",
      model: "openai/gpt-unsupported",
    });

    expect(
      codeModeConversationProofTesting.validateCodeModeConversationProofSummary(summary, {
        executionPolicy: unsupportedPolicy,
        gitSha: "abc123",
        model: "openai/gpt-unsupported",
      }).valid,
    ).toBe(false);
  });

  it("binds every cell to the configured agent and a distinct deterministic session key", () => {
    const summary = createValidConversationProofSummaryFixture({
      executionPolicy: executionPolicy({ defaultAgentId: "qa" }),
      gitSha: "abc123",
    });

    expect(
      codeModeConversationProofTesting.validateCodeModeConversationProofSummary(summary, {
        executionPolicy: executionPolicy({ defaultAgentId: "qa" }),
        gitSha: "abc123",
      }),
    ).toEqual({ valid: true });
    expect(cells(summary).map((cell) => cell.agentIdSha256)).toEqual([
      sha256("qa"),
      sha256("qa"),
      sha256("qa"),
    ]);
    expect(new Set(cells(summary).map((cell) => cell.sessionKeySha256)).size).toBe(3);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('"defaultAgentId":"qa"');
    expect(serialized).not.toContain('"agentId":"qa"');
    expect(serialized).not.toContain('"authProfileId":"openai:matrix"');
    expect(summary).toMatchObject({
      schemaVersion: 4,
      defaultAgentIdSha256: sha256("qa"),
      authProfileIdSha256: sha256("openai:matrix"),
    });
  });

  it("projects only the public v4 allowlist and binds removed evidence with commitments", () => {
    const summary = clonePublicSummary();
    const serialized = JSON.stringify(summary);

    for (const rawKey of [
      "execSource",
      "nestedCalls",
      "registeredRows",
      "listedRows",
      "value",
      "finalText",
      "outboundMessages",
    ]) {
      expect(serialized).not.toContain(`"${rawKey}":`);
    }
    expect(serialized).not.toContain("conv_");
    expect(serialized).not.toContain("message-exact");
    expect(serialized).not.toContain("dm:build-bot");
    expect(cells(summary)).toHaveLength(3);
    for (const cell of cells(summary)) {
      expect(cell.rawEvidenceSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(cell.nestedCallTraceSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(cell.returnedValueSha256).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  it("rejects extra public keys and implicit Code Mode activation", () => {
    const expected = {
      executionPolicy: executionPolicy(),
      gitSha: "abc123",
      model: "openai/gpt-5.6",
    };
    const extraSummary = clonePublicSummary() as ProofSummary & { extra?: boolean };
    extraSummary.extra = true;
    expect(
      codeModeConversationProofTesting.validateCodeModeConversationProofSummary(
        extraSummary,
        expected,
      ).valid,
    ).toBe(false);

    const extraCell = clonePublicSummary();
    (cells(extraCell)[0] as Record<string, unknown>).extra = true;
    expect(
      codeModeConversationProofTesting.validateCodeModeConversationProofSummary(extraCell, expected)
        .valid,
    ).toBe(false);

    const implicitActivation = clonePublicSummary();
    (implicitActivation.executionPolicy as Record<string, unknown>).codeModeActivation = "implicit";
    expect(
      codeModeConversationProofTesting.validateCodeModeConversationProofSummary(
        implicitActivation,
        expected,
      ).valid,
    ).toBe(false);
  });

  it("rejects shallow producer labels without raw evidence", () => {
    expect(
      codeModeConversationProofTesting.validateCodeModeConversationProofSummary(
        {
          schemaVersion: 2,
          evidenceClass: "frontier_beta_qualification",
          betaGateRole: "required_separate_behavior_gate_excluded_from_abba_totals",
          gitSha: "abc123",
          status: "pass",
          behaviorGateValidated: true,
          distinctSessionIds: true,
          distinctGatewayPids: true,
          counts: { total: 3, passed: 3, failed: 0 },
          cells: [
            { id: "Code-exact", passed: true },
            { id: "Code-ambiguous", passed: true },
            { id: "Code-incomplete", passed: true },
          ],
        },
        { gitSha: "abc123" },
      ).valid,
    ).toBe(false);
  });

  it("checks isolated route, profile, and credential bindings", () => {
    const config = {
      models: {
        mode: "replace",
        providers: {
          openai: {
            api: "openai-responses",
            auth: "api-key",
            baseUrl: "https://api.openai.com/v1",
            models: [],
          },
        },
      },
      auth: {
        profiles: {
          "openai:matrix": { provider: "openai", mode: "api_key" },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.6@openai:matrix",
            fallbacks: [],
          },
        },
        entries: {
          qa: { model: "openai/gpt-5.6@openai:matrix" },
        },
      },
    } satisfies OpenClawConfig;

    expect(
      codeModeConversationProofTesting.evaluateGatewayBindings({
        agentId: "qa",
        authProfileId: "openai:matrix",
        configuredPrimary: "openai/gpt-5.6@openai:matrix",
        endpoint: "https://api.openai.com/v1",
        expectedApi: "openai-responses",
        frozenEnv: { OPENAI_API_KEY: "frozen" },
        gatewayConfig: config,
        runtimeEnv: { OPENAI_API_KEY: "frozen" },
      }),
    ).toEqual({
      routeMatch: true,
      profileMatch: true,
      credentialBindingMatch: true,
    });
    expect(
      codeModeConversationProofTesting.evaluateGatewayBindings({
        agentId: "qa",
        authProfileId: "openai:matrix",
        configuredPrimary: "openai/gpt-5.6@openai:matrix",
        endpoint: "https://api.openai.com/v1",
        expectedApi: "openai-responses",
        frozenEnv: { OPENAI_API_KEY: "frozen" },
        gatewayConfig: config,
        runtimeEnv: { OPENAI_API_KEY: "ambient" },
      }).credentialBindingMatch,
    ).toBe(false);

    const firstGatewayConfig: OpenClawConfig = structuredClone(config);
    firstGatewayConfig.agents!.defaults!.workspace = "/isolated/cell-one";
    const secondGatewayConfig: OpenClawConfig = structuredClone(config);
    secondGatewayConfig.agents!.defaults!.workspace = "/isolated/cell-two";
    expect(codeModeConversationProofTesting.gatewayBindingSha256(firstGatewayConfig)).toBe(
      codeModeConversationProofTesting.gatewayBindingSha256(secondGatewayConfig),
    );
  });

  it("fills the canonical API default without discarding frozen provider fields", () => {
    const provider = codeModeConversationProofTesting.canonicalOpenAiProvider({
      buildSha256: "build",
      config: {
        models: {
          providers: {
            openai: {
              auth: "api-key",
              baseUrl: "https://api.openai.com/v1",
              models: [
                {
                  id: "gpt-5.6",
                  name: "Pinned frontier model",
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 1,
                  maxTokens: 1,
                },
              ],
            },
          },
        },
      },
      configSha256: "config",
      executionPolicy: executionPolicy(),
      frozenEnv: {},
      gitSha: "git",
      model: "openai/gpt-5.6",
      outputDir: "output",
      repoRoot: "repo",
    });

    expect(provider).toMatchObject({
      api: "openai-responses",
      auth: "api-key",
      baseUrl: "https://api.openai.com/v1",
    });
    expect(provider.models).toHaveLength(1);
  });

  it("invalidates a passing proof when cleanup fails", () => {
    const summary = codeModeConversationProofTesting.applyConversationProofCleanupOutcome(
      {
        status: "pass",
        counts: { total: 3, passed: 3, failed: 0 },
      },
      true,
    );

    expect(summary).toMatchObject({
      status: "fail",
      failureCode: "conversation_proof_cleanup_failed",
      cleanup: {
        status: "failed",
        failureCode: "conversation_proof_cleanup_failed",
      },
    });
  });

  it("preserves the primary failure when global outbound or cleanup diagnostics are added", async () => {
    const valid = cloneRawSummary();
    const validCells = cells(valid);
    const globalFailure = await codeModeConversationProofTesting.runConversationProofCells({
      runScenario: async (_definition: { id: string }, ordinal: number) => ({
        ...structuredClone(validCells[ordinal - 1]!),
        ...(ordinal === 3 ? { failureCode: "primary_cell_failure", passed: false } : {}),
        outboundMessageDelta: 0,
      }),
    });

    expect(globalFailure[2]).toMatchObject({
      failureCode: "primary_cell_failure",
      globalOutboundMessageDelta: 0,
      globalOutboundValid: false,
      passed: false,
    });
    expect(
      codeModeConversationProofTesting.applyConversationProofCleanupOutcome(
        {
          status: "fail",
          failureCode: "primary_summary_failure",
          counts: { total: 3, passed: 2, failed: 1 },
        },
        true,
      ),
    ).toMatchObject({
      status: "fail",
      failureCode: "primary_summary_failure",
      cleanup: {
        status: "failed",
        failureCode: "conversation_proof_cleanup_failed",
      },
    });
    expect(codeModeConversationProofTesting.firstConversationProofFailureCode(globalFailure)).toBe(
      "primary_cell_failure",
    );
    expect(
      codeModeConversationProofTesting.projectConversationProofSummary({
        ...valid,
        status: "fail",
        failureCode:
          codeModeConversationProofTesting.firstConversationProofFailureCode(globalFailure),
      }),
    ).toMatchObject({
      schemaVersion: 4,
      status: "fail",
      failureCode: "primary_cell_failure",
    });
  });

  it("reduces unexpected failures to bounded stable codes", () => {
    expect(
      codeModeConversationProofTesting.stableFailureCode(
        new Error("Authorization: Bearer should-not-escape"),
      ),
    ).toBe("conversation_proof_internal_failure");
    expect(
      codeModeConversationProofTesting.stableFailureCode(
        new Error("conversation_proof_gateway_route_mismatch"),
      ),
    ).toBe("conversation_proof_gateway_route_mismatch");
  });
});
