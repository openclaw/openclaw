import { describe, expect, it } from "vitest";
// @vitest-environment node
import {
  classifyRunInspection,
  mergeDecisionPage,
  type RunInspectorResult,
} from "./run-inspector-model.ts";

it("classifies unknown evidence without assigning a stronger diagnostic", () => {
  expect(
    classifyRunInspection({
      schemaVersion: 1,
      run: { runId: "run-1", status: "unknown" },
      identity: {
        state: "unknown",
        reasonCode: "run_evidence_unreadable",
        missingEvidence: ["identity.context"],
        remediation: [],
      },
      decisionDisplays: [],
      coverage: { state: "unknown", missingEvidence: [] },
    }),
  ).toBe("unknown");
});

describe("receipt paging model", () => {
  const present = {
    schemaVersion: 1,
    run: {
      runId: "run-1",
      executionId: "execution-1",
      status: "known" as const,
    },
    identity: {
      state: "present" as const,
      context: {
        schemaVersion: 1,
        contextId: "context-1",
        executionId: "execution-1",
        runId: "run-1",
        createdAt: 1,
        trustDomain: {
          kind: "gateway-cell" as const,
          domainRef: "domain",
          state: "present" as const,
        },
        invoker: { state: "absent" as const },
        ingress: {
          kind: "gateway-client" as const,
          boundary: "agent-command.gateway",
          state: "present" as const,
        },
        agentPrincipal: {
          kind: "agent" as const,
          domainRef: "domain",
          principalRef: "main",
        },
        agentDefinition: { definitionRef: "main", state: "unknown" as const },
        runtimeInstance: {
          runtimeRef: "gateway",
          kind: "gateway" as const,
          state: "present" as const,
        },
        applicableGrants: [],
        assurance: [],
        coverageState: "attribution-only" as const,
        missingEvidence: [],
      },
    },
    decisionDisplays: [],
    coverage: { state: "attribution-only" as const, missingEvidence: [] },
  } satisfies RunInspectorResult;

  it("merges only a page for the exact inspected execution and context", () => {
    const page = { ...present, nextDecisionCursor: "g:10:2" };
    expect(mergeDecisionPage(present, page)?.nextDecisionCursor).toBe("g:10:2");
    expect(
      mergeDecisionPage(present, {
        ...page,
        run: { ...page.run, executionId: "execution-2" },
      }),
    ).toBeNull();
  });
});
