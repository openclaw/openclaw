import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { executionIdentitySpawnAdmission } from "./execution-identity-spawn-admission.js";
import {
  executionIdentityFacts,
  prepareExecutionIdentityContextAtAdmission,
} from "./execution-identity.test-support.js";

afterEach(closeOpenClawStateDatabaseForTest);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const parent = {
  parentContextId: "parent-context",
  parentExecutionId: "parent-execution",
  parentRunId: "parent-run",
};
const missing = [
  "acp.native-action-callback",
  "invoker.principal",
  "lineage.parent-context",
  "lineage.parent-execution",
  "lineage.parent-run",
];

describe("execution identity child lineage", () => {
  it.each(["subagent", "acp"] as const)(
    "projects %s lineage without raw refs and deduplicates missing evidence",
    (kind) => {
      const complete = kind === "subagent";
      const facts = executionIdentityFacts("child-run", {
        ingress: { kind, boundary: `sessions_spawn.${kind}`, state: "present" },
        representedSubject: { state: "present", kind: "person", rawPrincipalRef: "subject" },
        applicableGrants: [{ rawGrantRef: "private-grant", state: "present" }],
        ...(complete
          ? {
              invoker: {
                state: "present" as const,
                kind: "agent" as const,
                rawPrincipalRef: "parent-agent",
              },
            }
          : {}),
      });
      const admission = executionIdentitySpawnAdmission({
        operation: "attach",
        value: facts,
        extra: executionIdentitySpawnAdmission({
          operation: "serialize",
          value: {
            ...(complete ? parent : {}),
            parentAgentId: "parent-agent",
            relation: "sessions_spawn",
            rawRequesterRef: "agent:main:private-requester",
            rawControllerRef: "agent:main:private-controller",
            depth: complete ? 2 : 1,
            localPolicyRefs: complete ? ["local-policy-secret"] : [],
            targetPolicyRefs: complete ? ["target-policy-secret"] : [],
          },
          extra: complete ? [] : missing.toReversed(),
        }),
      });
      const context = prepareExecutionIdentityContextAtAdmission(admission, {
        env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-lineage-") },
      });
      expect(context.coverageState).toBe("attribution-only");
      expect(context.representedSubject?.state).toBe("present");
      expect(context.representedSubject?.principal.kind).toBe("person");
      expect(context.representedSubject?.principal.domainRef).toBe(context.trustDomain.domainRef);
      expect(context.representedSubject?.principal.principalRef).toMatch(/^hmac-sha256:v1:/u);
      expect(context.applicableGrants).toHaveLength(1);
      if (complete) {
        expect(context.invoker.principal?.kind).toBe("agent");
      }
      expect(context.lineage).toEqual({
        ...(complete ? parent : {}),
        parentAgentPrincipal: {
          kind: "agent",
          domainRef: context.trustDomain.domainRef,
          principalRef: "parent-agent",
        },
        depth: complete ? 2 : 1,
        delegationRef: expect.any(String),
      });
      expect(context.missingEvidence).toEqual(complete ? [] : missing);
      expect(JSON.stringify(context)).not.toMatch(
        /subject|private-grant|private-requester|private-controller|local-policy-secret|target-policy-secret/,
      );
    },
  );
});
