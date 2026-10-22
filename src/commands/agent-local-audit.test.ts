import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, assert, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type AdmittedRunContext,
  type PreparedAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { recordAdmittedModelRoutingDecision } from "../agents/model-routing-decision.js";
import { recordRuntimeActionDecision } from "../audit/runtime-action-decision.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { runAgentExecWithMock } from "./agent-exec.test-helpers.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("persists runtime receipts for an opted-in direct CLI run and clears its sink", async () => {
  const root = tempDirs.make("openclaw-agent-exec-audit-");
  let modelAdmission: PreparedAgentRunAdmission | undefined;
  let admittedRunContext: AdmittedRunContext | undefined;
  const requireToken = () => {
    const token = admittedRunContext?.executionIdentityToken;
    assert(token, "expected direct-local execution identity token");
    return token;
  };
  const recordRuntimeReceipt = () =>
    recordRuntimeActionDecision({
      token: requireToken(),
      family: "plugin",
      operation: "runtime",
      outcome: "allowed",
      coverageState: "attribution-only",
      reasonCode: "agent_exec_runtime_recorded",
      owner: "plugin-runtime",
      decisionBoundary: "agent-command.local",
      summary: "The direct local run recorded a bounded runtime action.",
      remediation: [],
    });
  const recordModelRouting = () =>
    recordAdmittedModelRoutingDecision({
      admittedRunContext,
      requestedProvider: "openai",
      requestedModel: "gpt-5.6",
      selectedProvider: "openai",
      selectedModel: "gpt-5.6-sol",
      selectionMode: "automatic",
      credentialProfileId: "openai:direct-local-profile",
    });
  setRuntimeConfigSnapshot({ logging: { audit: { executionIdentity: true } } });
  try {
    const result = await runAgentExecWithMock(
      "inspect",
      { stateDir: root },
      createTestRuntime(),
      vi.fn(async () => {
        modelAdmission = prepareAgentRunAdmission({
          cfg: { logging: { audit: { executionIdentity: true } } },
          operationalRunInstance: createOperationalRunInstanceRef("agent-exec-run"),
          facts: {
            runId: "agent-exec-run",
            agentId: "main",
            ingress: {
              kind: "local-cli",
              boundary: "agent-command.local",
              state: "present",
            },
          },
        });
        admittedRunContext = await modelAdmission.admit("embedded", "agent-exec-runtime");
        expect(recordModelRouting()).toBe(true);
        expect(recordRuntimeReceipt()).toBe(true);
        return { meta: { durationMs: 1 } };
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(recordRuntimeReceipt()).toBe(false);
    expect(recordModelRouting()).toBe(false);
    const token = requireToken();
    using database = new DatabaseSync(path.join(root, "state", "openclaw.sqlite"), {
      readOnly: true,
    });
    const identity = {
      contextId: token.contextId,
      executionId: token.executionId,
      runId: token.runId,
    };
    const context = database
      .prepare("SELECT context_json FROM execution_identity_contexts WHERE execution_id = ?")
      .get(token.executionId)!;
    expect(JSON.parse(String(context.context_json))).toMatchObject({
      ...identity,
      ingress: { kind: "local-cli", state: "present" },
    });
    const receiptSql =
      "SELECT receipt_json FROM execution_decision_facts WHERE execution_id = ? AND action_family = ?";
    const readReceipt = (family: string) =>
      String(database.prepare(receiptSql).get(token.executionId, family)!.receipt_json);
    expect(JSON.parse(readReceipt("plugin"))).toMatchObject({
      ...identity,
      action: { family: "plugin", operation: "runtime" },
      decision: { outcome: "allowed", reasonCode: "agent_exec_runtime_recorded" },
    });
    const modelReceipt = readReceipt("model-routing");
    expect(JSON.parse(modelReceipt)).toMatchObject({
      action: {
        family: "model-routing",
        operation: "automatic-selection",
        resourceRef: expect.stringMatching(/^hmac-sha256:v1:/u),
        targetRef: expect.stringMatching(/^hmac-sha256:v1:/u),
      },
    });
    expect(modelReceipt).not.toContain("openai:direct-local-profile");
  } finally {
    modelAdmission?.close();
    clearRuntimeConfigSnapshot();
  }
});
