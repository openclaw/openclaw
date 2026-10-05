import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { observePausedBoundary } from "../scripts/lib/upgrade-qualification-inspector.mjs";
import {
  assertObservationAudit,
  assertOwnerObservationProvenance,
} from "../scripts/lib/upgrade-qualification-observation-files.mjs";

const original = "00000000-0000-4000-8000-000000000001";
const source = "function originalOwner() { return commit(); }";
const script = {
  path: "/qualification/runner/owner.mjs",
  length: Buffer.byteLength(source),
  sha256: createHash("sha256").update(source).digest("hex"),
};
const location = { lineNumber: 4, columnNumber: 8 };
const ancestor = {
  callFrameId: "original-owner",
  functionName: "originalOwner",
  location: { scriptId: "owner", ...location },
};
const top = {
  callFrameId: "sqlite-commit",
  functionName: "commit",
  location: { scriptId: "sqlite", lineNumber: 2, columnNumber: 4 },
};
function fixture(maintenanceHeld = true) {
  const frame = { script, functionName: ancestor.functionName, location };
  const mapping = {
    location: top.location,
    guardExpression: "options.database === database",
    actionId: "publish",
    operation: "state.schema.repair",
    facts: { runId: "original.runId", actionId: "original.action", operation: "options.operation" },
    factFrames: { runId: frame, actionId: frame },
  };
  const values: Record<string, Record<string, unknown>> = {
    "sqlite-commit": {
      "options.database === database": true,
      "options.operation": "state.schema.repair",
      "state.upgradeMaintenance !== undefined": maintenanceHeld,
      "state.suspendPhase": "suspended",
    },
    "original-owner": { "original.runId": original, "original.action": "publish" },
  };
  const transport = {
    call: vi.fn(async (method: string, params: { callFrameId?: string; expression?: string }) => {
      if (method === "Debugger.getScriptSource") {
        return { scriptSource: source };
      }
      return { result: { value: values[params.callFrameId ?? ""]?.[params.expression ?? ""] } };
    }),
  };
  return {
    transport,
    mapping,
    original,
    pause: { callFrames: [top, ancestor] },
    scripts: new Map([["owner", { url: script.path }]]),
    binding: {},
    onLiveTarget: undefined,
  };
}

it("reads original identity from the exact synchronous owner without inventing a parent job", async () => {
  const input = fixture();
  const observed = await observePausedBoundary(input);
  expect(observed.observedFacts).toEqual({
    runId: original,
    actionId: "publish",
    operation: "state.schema.repair",
  });
  expect(input.transport.call).toHaveBeenCalledWith("Debugger.evaluateOnCallFrame", {
    callFrameId: "original-owner",
    expression: "original.runId",
    returnByValue: true,
    throwOnSideEffect: true,
  });
  expect(input.transport.call.mock.calls.some(([method]) => method === "Debugger.resume")).toBe(
    false,
  );
});

it.each(["missing", "ambiguous", "relocated", "changed-source"])(
  "holds a %s original owner frame",
  async (kind) => {
    const input = fixture();
    if (kind === "missing") {
      input.pause.callFrames = [top];
    } else if (kind === "ambiguous") {
      input.pause.callFrames.push({ ...ancestor, callFrameId: "duplicate" });
    } else if (kind === "relocated") {
      input.pause.callFrames = [
        top,
        { ...ancestor, location: { ...ancestor.location, columnNumber: 9 } },
      ];
    } else {
      input.mapping.factFrames.runId.script = { ...script, sha256: "b".repeat(64) };
    }
    await expect(observePausedBoundary(input)).rejects.toThrow(/frame|immutable script/);
  },
);

it("does not reinterpret a side-effect refusal as permission to use a different frame", async () => {
  const input = fixture();
  input.transport.call.mockImplementationOnce(async () => ({
    result: { value: undefined },
    exceptionDetails: { text: "side effect" },
  }));
  await expect(observePausedBoundary(input)).rejects.toThrow(/Read-only guard observation refused/);
  expect(input.transport.call).toHaveBeenCalledTimes(1);
});

it.each([true, false])(
  "observes held-runtime maintenance=%s before SIGSTOP without claiming suspension is open",
  async (maintenanceHeld) => {
    const input = fixture(maintenanceHeld);
    const heldRuntime = {
      maintenanceHeldExpression: "state.upgradeMaintenance !== undefined",
      suspensionPhaseExpression: "state.suspendPhase",
      expected: { maintenanceHeld, suspensionPhase: "suspended" },
    };
    await expect(
      observePausedBoundary({ ...input, mapping: { ...input.mapping, heldRuntime } }),
    ).resolves.toMatchObject({
      heldRuntime: {
        maintenanceHeld,
        suspensionPhase: "suspended",
        stage: "debugger-held-before-kernel-stop",
      },
    });
    await expect(
      observePausedBoundary({
        ...input,
        mapping: {
          ...input.mapping,
          heldRuntime: {
            ...heldRuntime,
            expected: { ...heldRuntime.expected, maintenanceHeld: !maintenanceHeld },
          },
        },
      }),
    ).rejects.toThrow(/reviewed boundary side/);
  },
);

it("binds frame selectors, held observations and execution snapshot semantics into the review audit", () => {
  const input = fixture();
  const mapping = {
    ...input.mapping,
    id: "selected",
    phase: "fresh",
    script,
    entry: script,
    source: script,
    sourceMap: script,
    sourceLocation: location,
    snapshotContract: "original-run-pre-migration-backup",
  };
  const binding = { boundary: "snapshot-completion", side: "after", runId: original };
  const audit = {
    ...mapping,
    ...binding,
    purpose: "reviewed-unchanged-artifact-boundary",
    mappingId: mapping.id,
    scriptSha256: script.sha256,
    entrySha256: script.sha256,
    sourceSha256: script.sha256,
    sourceMapSha256: script.sha256,
    guardReadOnly: true,
    effectOrdering: true,
    basis: "Exact backup owner continuation",
  };
  expect(() => assertObservationAudit(audit, mapping, binding)).not.toThrow();
  expect(() =>
    assertObservationAudit({ ...audit, factFrames: undefined }, mapping, binding),
  ).toThrow(/exact inputs/);
  expect(() =>
    assertObservationAudit({ ...audit, snapshotContract: undefined }, mapping, binding),
  ).toThrow(/exact inputs/);
  expect(() =>
    assertObservationAudit({ ...audit, heldRuntime: { invented: true } }, mapping, binding),
  ).toThrow(/exact inputs/);
});

// These joins protect against real owner substitution, not an asserted mapping label.
// The independent durable observation must select the same retained native generation.
function ownerFixture(kind: "maintenance-binding" | "publication-owner") {
  const digest = "a".repeat(64);
  const artifact = (name: string, text: string) => ({
    path: `/qualification/${name}`,
    length: Buffer.byteLength(text),
    sha256: createHash("sha256").update(text).digest("hex"),
  });
  const binding = {
    protocol: 1,
    runId: original,
    planDigest: digest,
    targetArtifactId: "target",
    installationKey: "/qualification/npm/lib/node_modules/openclaw",
    stateRootKey: "/qualification/state",
  };
  const operation =
    kind === "maintenance-binding" ? "core.gateway-maintenance" : "core.package-publish";
  const step = {
    protocol: 1,
    runId: original,
    planDigest: digest,
    stepId: "compiled-step-1",
    adapterId: operation,
    recipeId: "historical",
    recipeRevision: 1,
    adapterRevision: 1,
    adapterArtifactDigest: digest,
    phase: "postpublish-maintenance",
    resources: [
      {
        resourceKey: "package:root",
        identityDigest: digest,
        beforeDigest: digest,
        expectedAfterDigest: digest,
      },
    ],
  };
  const nativeAuthority = {
    installKey: binding.installationKey,
    databasePath: "/qualification/native.sqlite",
    databaseIdentity: "1:4",
    parentIdentity: "1:3",
  };
  const ledgerAuthority = {
    databasePath: "/qualification/ledger.sqlite",
    databaseIdentity: "1:2",
    parentIdentity: "1:3",
  };
  const runner = { manifestDigest: digest, closureDigest: digest };
  const planText = JSON.stringify({
    maintenance: { binding },
    approvedPlanDigest: digest,
    approvedPlan: { digest },
    route: { recipe: { id: "historical", revision: 1 } },
    catalogDigest: digest,
    runner,
  });
  const authorizationText = JSON.stringify({ digest });
  const envelopeText = JSON.stringify({
    binding,
    nativeAuthority,
    ledgerAuthority,
    originalNativeOwner: "native-original-owner",
    runner,
    stepBindings: [step],
    planArtifact: artifact("plan.json", planText),
    authorizationArtifact: artifact("authorization.json", authorizationText),
  });
  const custody = {
    runId: original,
    createdAtMs: 123,
    pointer: {
      runId: original,
      nativeAuthority,
      ledgerAuthority,
      envelope: artifact("envelope.json", envelopeText),
    },
  };
  const descriptor = {
    operationId: "00000000-0000-4000-8000-000000000002",
    authority: { ...nativeAuthority, owner: "native-original-owner" },
    candidate: { identity: "1:8", digest, version: "candidate" },
    previous: { identity: "1:9", digest, version: "historical" },
  };
  const observed = { kind, payload: kind === "maintenance-binding" ? binding : descriptor };
  const evidence = {
    envelopeText,
    planText,
    authorizationText,
    durable: {
      stepReceipt: { binding: step, phase: "intent", revision: 1 },
      maintenanceReceipt: {
        binding: structuredClone(binding),
        phase: "commit-intent",
        revision: 2,
      },
      publicationRecord: {
        descriptor: structuredClone(descriptor),
        phase: "publishing",
        intent: { kind: "publish" },
        revision: 3,
      },
    },
  };
  const mapping = {
    actionId: step.stepId,
    operation,
    facts: { kind, payloadExpression: "ownerBinding" },
  };
  const boundary = kind === "maintenance-binding" ? "gate-release" : "package-publication";
  return { mapping, boundary, observed, evidence, custody };
}
function verifyOwner(f: ReturnType<typeof ownerFixture>) {
  return assertOwnerObservationProvenance(
    f.mapping,
    f.boundary,
    original,
    f.observed,
    f.evidence,
    f.custody,
  );
}

it.each(["maintenance-binding", "publication-owner"] as const)(
  "captures actual %s payload without inventing scalar action or operation facts",
  async (kind) => {
    const f = ownerFixture(kind);
    const input = fixture();
    const call = vi.fn(async (_method: string, params: { expression: string }) => ({
      result: {
        value:
          params.expression === "guard"
            ? true
            : params.expression === "ownerBinding"
              ? f.observed.payload
              : undefined,
      },
    }));
    const observed = await observePausedBoundary({
      ...input,
      transport: { call },
      mapping: {
        ...input.mapping,
        guardExpression: "guard",
        factFrames: {},
        facts: f.mapping.facts,
      },
    });
    expect(observed.observedFacts).toEqual(f.observed);
    expect(call.mock.calls.map(([, params]) => params.expression)).toEqual([
      "guard",
      "ownerBinding",
    ]);
    expect(() => verifyOwner(f)).not.toThrow();
  },
);

it.each(["maintenance-binding", "publication-owner"] as const)(
  "rejects %s evidence from a different approved action or altered retained bytes",
  (kind) => {
    const foreignStep = ownerFixture(kind);
    foreignStep.evidence.durable.stepReceipt.binding = {
      ...foreignStep.evidence.durable.stepReceipt.binding,
      stepId: "other",
    };
    expect(() => verifyOwner(foreignStep)).toThrow(/exact retained action/);
    const altered = ownerFixture(kind);
    altered.evidence.planText += " ";
    expect(() => verifyOwner(altered)).toThrow(/original retained bytes/);
    const missing = ownerFixture(kind);
    expect(() =>
      assertOwnerObservationProvenance(
        missing.mapping,
        missing.boundary,
        original,
        undefined,
        missing.evidence,
        missing.custody,
      ),
    ).toThrow(/Missing captured owner/);
  },
);

it("rejects a foreign maintenance binding and a non-commit receipt even with matching run UUID", () => {
  const f = ownerFixture("maintenance-binding");
  f.evidence.durable.maintenanceReceipt.binding.targetArtifactId = "foreign-target";
  expect(() => verifyOwner(f)).toThrow(/durable original commit intent/);
  const beforeIntent = ownerFixture("maintenance-binding");
  beforeIntent.evidence.durable.maintenanceReceipt.phase = "maintenance-required";
  expect(() => verifyOwner(beforeIntent)).toThrow(/durable original commit intent/);
});

it("rejects random operation or original native owner substitution in the durable publication journal", () => {
  const operation = ownerFixture("publication-owner");
  operation.evidence.durable.publicationRecord.descriptor.operationId = original;
  expect(() => verifyOwner(operation)).toThrow(/original native journal operation/);
  const native = ownerFixture("publication-owner");
  const descriptor = native.evidence.durable.publicationRecord.descriptor;
  descriptor.authority.owner = "another-native-generation";
  native.observed.payload = structuredClone(descriptor);
  expect(() => verifyOwner(native)).toThrow(/original native journal operation/);
});
