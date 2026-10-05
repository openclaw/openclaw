import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { admitSession } from "../scripts/lib/upgrade-qualification-inspector.mjs";
import { parseHistoricalObservationReceipt } from "../scripts/lib/upgrade-qualification-observation-collection.mts";
import { historicalObservationSchema } from "../scripts/lib/upgrade-qualification-observation-contract.mts";
import {
  assertCompilerMapping,
  assertExactObservedLocation,
  assertObservationAudit,
  parseObservedProcess,
  assertNativeObservationSelectors,
  assertOriginalRetainedCustody,
} from "../scripts/lib/upgrade-qualification-observation-files.mjs";
import {
  observationFixture,
  observationRunId as runId,
  requiredItem,
} from "./upgrade-qualification.test-support.js";

const file = (name: string) => ({
  path: `/qualification/${name}`,
  sha256: "a".repeat(64),
  length: 1,
});
const entry = file("runner/entry.mjs");
const script = file("runner/owner.mjs");
const native = file("bootstrap");
const sourceMap = file("owner.mjs.map");
const runtime = file("runner/node");
const mapping = (phase: "fresh" | "retained") => ({
  id: phase,
  phase,
  entry,
  script,
  location: { lineNumber: 3, columnNumber: 7 },
  guardExpression: "runId === 'original'",
  actionId: "core.package-publish",
  operation: "state.schema.repair",
  database: "/qualification/state/state/openclaw.sqlite",
  semanticAudit: file(`${phase}-audit.json`),
  source: file("source.ts"),
  sourceMap: file("owner.mjs.map"),
  sourceName: "src/owner.ts",
  sourceLocation: { lineNumber: 1, columnNumber: 2 },
  jobId: "migration-job",
  facts: {
    runId: "job.runId",
    actionId: "job.actionId",
    operation: "options.operationLabel",
    jobId: "job.id",
    database: "options.databaseLabel",
  },
});
const binding = () => ({
  ...observationFixture(native.path),
  boundary: "migration-commit",
  observer: file("observer.mjs"),
  observerFiles: [
    file("observer.mjs"),
    file("upgrade-qualification-inspector.mjs"),
    file("upgrade-qualification-observation-files.mjs"),
  ],
  runtime,
  nativeBootstrap: native,
  artifacts: [entry, script, native, runtime, sourceMap],
  mappings: [
    mapping("fresh"),
    mapping("retained"),
    {
      ...mapping("fresh"),
      id: "capture",
      location: { lineNumber: 2, columnNumber: 7 },
      captureRunExpression: "runId",
      captureStage: "recipe-plan-uuid-before-ledger-admission",
      sourceName: "src/cli/update-cli/recipe-plan.ts",
    },
  ],
  durableProbe: {
    executable: file("probe"),
    argv: [runId],
    expected: { committed: true },
    audit: file("probe-audit.json"),
  },
  serviceCgroups: ["/system.slice/openclaw.service"],
});
const audit = () => ({
  purpose: "reviewed-unchanged-artifact-boundary",
  boundary: "migration-commit",
  side: "after",
  runId,
  mappingId: "fresh",
  phase: "fresh",
  scriptSha256: script.sha256,
  entrySha256: entry.sha256,
  actionId: "core.package-publish",
  operation: "state.schema.repair",
  database: "/qualification/state/state/openclaw.sqlite",
  guardExpression: "runId === 'original'",
  location: { lineNumber: 3, columnNumber: 7 },
  jobId: "migration-job",
  facts: mapping("fresh").facts,
  sourceSha256: "a".repeat(64),
  sourceMapSha256: "a".repeat(64),
  sourceLocation: { lineNumber: 1, columnNumber: 2 },
  guardReadOnly: true,
  effectOrdering: true,
  basis: "Reviewed exact commit continuation and original database/job.",
});

describe("unchanged-artifact crash observation admission", () => {
  it("binds selectors to native flag/value pairs, not argument membership", () => {
    const valid = binding();
    expect(assertNativeObservationSelectors(valid).apply["--installation"]).toEqual([
      valid.installation,
    ]);
    const swapped = binding();
    swapped.resume[swapped.resume.indexOf("--retained-ledger") + 1] = "/qualification/other.sqlite";
    swapped.resume.push(valid.ledger);
    expect(() => historicalObservationSchema.parse(swapped)).toThrow();
    const duplicate = binding();
    duplicate.apply.push("--installation", valid.installation);
    expect(() => historicalObservationSchema.parse(duplicate)).toThrow(/Duplicate/);
    const runnerOnly = binding();
    runnerOnly.apply.splice(1, 0, "--");
    expect(() => historicalObservationSchema.parse(runnerOnly)).toThrow();
    const wrongControl = binding();
    wrongControl.apply[wrongControl.apply.indexOf("--control-root") + 1] = "/qualification/foreign";
    wrongControl.apply.push("/qualification/control");
    expect(() => historicalObservationSchema.parse(wrongControl)).toThrow();
    const workspaces = binding();
    workspaces.nativeArguments.push(
      "--workspace",
      "/qualification/workspace-a",
      "--workspace",
      "/qualification/workspace-b",
    );
    workspaces.apply.push(...workspaces.nativeArguments.slice(2));
    workspaces.resume.push(...workspaces.nativeArguments.slice(2));
    expect(() => historicalObservationSchema.parse(workspaces)).not.toThrow();
    const offset = workspaces.resume.indexOf("--workspace");
    workspaces.resume[offset + 1] = "/qualification/workspace-b";
    workspaces.resume[offset + 3] = "/qualification/workspace-a";
    expect(() => historicalObservationSchema.parse(workspaces)).toThrow();
  });
  it("rejects external receipts with altered retained custody or native selectors", () => {
    const selected = historicalObservationSchema.parse(binding());
    const custody = {
      runId,
      createdAtMs: 123,
      pointer: {
        schemaVersion: 1,
        runId,
        originalCreatedAtMs: 123,
        envelope: file("envelope.json"),
        ledgerAuthority: {
          databasePath: selected.ledger,
          databaseIdentity: "1:2",
          parentIdentity: "1:3",
        },
        nativeAuthority: {
          installKey: selected.installation,
          databasePath: "/qualification/native.sqlite",
          databaseIdentity: "1:4",
          parentIdentity: "1:3",
        },
      },
    };
    const receipt = {
      purpose: selected.purpose,
      observationId: runId,
      originalRunId: runId,
      boundary: selected.boundary,
      side: selected.side,
      crashRecoveryObserved: true,
      qualificationPassed: false,
      admissions: [{}, {}],
      retained: [{}],
      nativeSelectors: assertNativeObservationSelectors(selected),
      originalCustody: custody,
      resumedCustody: structuredClone(custody),
    };
    expect(() => parseHistoricalObservationReceipt(receipt, selected, runId)).not.toThrow();
    const ownerSelected = historicalObservationSchema.parse({
      ...binding(),
      boundary: "package-publication",
      mappings: binding().mappings.map((item) =>
        item.id === "fresh"
          ? Object.assign({}, item, {
              operation: "core.package-publish",
              jobId: undefined,
              database: undefined,
              facts: { kind: "publication-owner", payloadExpression: "descriptor" },
            })
          : item,
      ),
    });
    expect(() =>
      parseHistoricalObservationReceipt(
        {
          ...receipt,
          boundary: "package-publication",
          boundaryObservation: { mappingId: "fresh" },
        },
        ownerSelected,
        runId,
      ),
    ).toThrow(/Missing captured owner/);

    const creationSwap = structuredClone(receipt);
    creationSwap.resumedCustody.createdAtMs++;
    expect(() => parseHistoricalObservationReceipt(creationSwap, selected, runId)).toThrow(
      /custody/,
    );
    const envelopeSwap = structuredClone(receipt);
    envelopeSwap.resumedCustody.pointer.envelope.sha256 = "b".repeat(64);
    expect(() => parseHistoricalObservationReceipt(envelopeSwap, selected, runId)).toThrow(
      /custody/,
    );
    const selectorSwap = structuredClone(receipt);
    selectorSwap.nativeSelectors.resume["--retained-ledger"] = ["/qualification/foreign"];
    expect(() => parseHistoricalObservationReceipt(selectorSwap, selected, runId)).toThrow(
      /custody/,
    );
    const gate = historicalObservationSchema.parse({
      ...binding(),
      boundary: "gate-release",
      mappings: binding().mappings.map((item) =>
        item.id === "fresh"
          ? Object.assign({}, item, {
              sourceName: "src/process/gateway-work-admission.ts",
              heldRuntime: {
                maintenanceHeldExpression: "state.upgradeMaintenance !== undefined",
                suspensionPhaseExpression: "state.suspendPhase",
                expected: { maintenanceHeld: false, suspensionPhase: "suspended" },
              },
            })
          : item,
      ),
    });
    const gateReceipt = {
      ...receipt,
      boundary: "gate-release",
      boundaryObservation: {
        mappingId: "fresh",
        heldRuntime: {
          maintenanceHeld: false,
          suspensionPhase: "suspended",
          stage: "debugger-held-before-kernel-stop",
        },
      },
    };
    expect(() => parseHistoricalObservationReceipt(gateReceipt, gate, runId)).not.toThrow();
    expect(() =>
      parseHistoricalObservationReceipt(
        { ...gateReceipt, boundaryObservation: undefined },
        gate,
        runId,
      ),
    ).toThrow(/held-runtime/);
    expect(() =>
      parseHistoricalObservationReceipt(
        {
          ...gateReceipt,
          boundaryObservation: {
            ...gateReceipt.boundaryObservation,
            heldRuntime: { ...gateReceipt.boundaryObservation.heldRuntime, maintenanceHeld: true },
          },
        },
        gate,
        runId,
      ),
    ).toThrow(/held-runtime/);
  });
  it("freezes original retained custody without freezing mutable run status", () => {
    const selected = { ...binding(), originalRunId: runId };
    const row = {
      runId,
      createdAtMs: 123,
      status: "running",
      pointer: {
        schemaVersion: 1,
        runId,
        originalCreatedAtMs: 123,
        envelope: file("retained/envelope.json"),
        ledgerAuthority: {
          databasePath: selected.ledger,
          databaseIdentity: "1:2",
          parentIdentity: "1:3",
        },
        nativeAuthority: { installKey: selected.installation },
      },
    };
    const before = assertOriginalRetainedCustody(row, selected);
    expect(assertOriginalRetainedCustody({ ...row, status: "succeeded" }, selected)).toEqual(
      before,
    );
    expect(() => assertOriginalRetainedCustody({ ...row, pointer: undefined }, selected)).toThrow(
      /custody/,
    );
    expect(() => assertOriginalRetainedCustody({ ...row, createdAtMs: 124 }, selected)).toThrow(
      /custody/,
    );
    expect(() => assertOriginalRetainedCustody({ ...row, runId: "another" }, selected)).toThrow(
      /custody/,
    );
  });
  it("requires fresh and retained generated mappings and exact original native selectors", () => {
    expect(historicalObservationSchema.parse(binding()).runId).toBe(runId);
    const onlyFresh = binding();
    onlyFresh.mappings = [mapping("fresh")];
    expect(() => historicalObservationSchema.parse(onlyFresh)).toThrow();
    const wrongRun = binding();
    wrongRun.resume = wrongRun.resume.map((arg) =>
      arg === "{{original-run-id}}" ? "another-run" : arg,
    );
    expect(() => historicalObservationSchema.parse(wrongRun)).toThrow(/original native/);
    const production = binding();
    production.apply = production.apply.filter((arg) => arg !== "--release-qualification");
    expect(() => historicalObservationSchema.parse(production)).toThrow();
    const lateCapture = binding();
    requiredItem(lateCapture.mappings, 2).sourceName = "src/cli/update-cli/update-command-run.ts";
    expect(() => historicalObservationSchema.parse(lateCapture)).toThrow(/before ledger admission/);
  });
  it("does not admit generic SQLite commits, mutable script inputs or missing startup custody", () => {
    const generic = binding();
    requiredItem(generic.mappings, 0).operation = "receipt.commit";
    expect(() => historicalObservationSchema.parse(generic)).toThrow(/schema-repair/);
    const changed = binding();
    requiredItem(changed.mappings, 0).script = { ...script, sha256: "b".repeat(64) };
    expect(() => historicalObservationSchema.parse(changed)).toThrow(/immutable closure/);
    const ungated = binding();
    ungated.resume = ungated.resume.filter((arg) => arg !== "--qualification-inspector");
    expect(() => historicalObservationSchema.parse(ungated)).toThrow(/startup gate/);
  });
  it.each([
    "runId",
    "mappingId",
    "phase",
    "scriptSha256",
    "entrySha256",
    "actionId",
    "operation",
    "database",
    "guardExpression",
    "side",
  ])("rejects stale %s semantic proof", (key) => {
    const stale = { ...audit(), [key]: "wrong" };
    expect(() => assertObservationAudit(stale, mapping("fresh"), binding())).toThrow(
      /exact inputs/,
    );
  });
  it("selects execution backup semantics rather than the earlier planner rehearsal", () => {
    const base = binding();
    const snapshot = {
      ...base,
      boundary: "snapshot-completion",
      mappings: base.mappings.map((item) =>
        item.id === base.selectedMappingId
          ? {
              ...item,
              snapshotContract: "original-run-pre-migration-backup",
              sourceName: "src/cli/update-cli/update-command-database-backup.ts",
            }
          : item,
      ),
    };
    expect(() => historicalObservationSchema.parse(snapshot)).not.toThrow();
    expect(() =>
      historicalObservationSchema.parse({
        ...snapshot,
        mappings: snapshot.mappings.map((item) =>
          item.id === base.selectedMappingId
            ? Object.assign({}, item, { sourceName: "src/infra/update-candidate-snapshot.ts" })
            : item,
        ),
      }),
    ).toThrow(/never planner rehearsal/);
  });
  it("requires actual worker jobs but allows parent continuations without synthetic jobs", () => {
    const base = binding();
    const parent = {
      ...base,
      mappings: base.mappings.map((item) =>
        Object.assign({}, item, {
          jobId: undefined,
          facts: { ...item.facts, jobId: undefined },
        }),
      ),
    };
    expect(() => historicalObservationSchema.parse(parent)).not.toThrow();
    expect(() =>
      historicalObservationSchema.parse({
        ...parent,
        mappings: parent.mappings.map((item) =>
          Object.assign({}, item, {
            worker: { url: "file:///qualification/worker.js", occurrence: 1 },
          }),
        ),
      }),
    ).toThrow(/real job discriminator/);
  });
  it.each(["before", "after"])(
    "requires side-specific held runtime for gate-release %s",
    (side) => {
      const base = binding();
      const gate = {
        ...base,
        boundary: "gate-release",
        side,
        mappings: base.mappings.map((item) =>
          item.id === base.selectedMappingId
            ? Object.assign({}, item, {
                sourceName: "src/process/gateway-work-admission.ts",
                heldRuntime: {
                  maintenanceHeldExpression: "state.upgradeMaintenance !== undefined",
                  suspensionPhaseExpression: "state.suspendPhase",
                  expected: { maintenanceHeld: side === "before", suspensionPhase: "accepting" },
                },
              })
            : item,
        ),
      };
      expect(() => historicalObservationSchema.parse(gate)).not.toThrow();
      expect(() =>
        historicalObservationSchema.parse({
          ...gate,
          side: side === "before" ? "after" : "before",
        }),
      ).toThrow(/side-specific held-runtime/);
    },
  );
  it("refuses V8 relocation and Linux PID identity ambiguity", () => {
    expect(() =>
      assertExactObservedLocation(
        { lineNumber: 3, columnNumber: 7 },
        { lineNumber: 3, columnNumber: 8 },
      ),
    ).toThrow(/relocated/);
    const fields = ["T", "2", "9", ...Array.from({ length: 16 }, () => "0"), "1234"];
    expect(parseObservedProcess(`17 (name with ) parentheses) ${fields.join(" ")}`)).toMatchObject({
      state: "T",
      parent: 2,
      group: 9,
      startTime: "1234",
    });
    expect(() => parseObservedProcess("invalid")).toThrow();
  });
});

it("arms an imported generated script before releasing it and retains a rejected run guard", async () => {
  const source = "export const immutable = true;";
  const digest = createHash("sha256").update(source).digest("hex");
  const selected = {
    ...mapping("fresh"),
    script: { ...script, sha256: digest, length: Buffer.byteLength(source) },
  };
  const current = { ...binding(), artifacts: [{ ...selected.script }], selectedMappingId: "fresh" };
  const boundary = vi.fn();
  let rejectGuard: (error: Error) => void = () => {};
  const refused = new Promise<Error>((resolve) => {
    rejectGuard = resolve;
  });
  const calls: string[] = [];
  const handlers: Array<(message: unknown) => void> = [];
  const transport = {
    handlers,
    call: vi.fn(async (method: string) => {
      calls.push(method);
      if (method === "Runtime.runIfWaitingForDebugger") {
        handlers.forEach((handler) =>
          handler({
            method: "Debugger.paused",
            params: { reason: "Break on start", callFrames: [] },
          }),
        );
      }
      if (method === "Runtime.evaluate") {
        return { result: { value: 42 } };
      }
      if (method === "Debugger.setInstrumentationBreakpoint") {
        return { breakpointId: "gate" };
      }
      if (method === "Debugger.getScriptSource") {
        return { scriptSource: source };
      }
      if (method === "Debugger.setBreakpoint") {
        return { breakpointId: "boundary", actualLocation: selected.location };
      }
      if (method === "Debugger.evaluateOnCallFrame") {
        return { result: { value: false } };
      }
      return {};
    }),
  };
  await admitSession({
    transport,
    mappings: [selected],
    binding: current,
    phase: "fresh",
    process: { pid: 42 },
    onBoundary: boundary,
    onError: rejectGuard,
    originalRunId: () => runId,
    onCaptureRun: vi.fn(),
    worker: undefined,
    onWorker: undefined,
    onLiveTarget: undefined,
  });
  handlers.forEach((handler) =>
    handler({
      method: "Debugger.scriptParsed",
      params: { scriptId: "imported", url: selected.script.path },
    }),
  );
  handlers.forEach((handler) =>
    handler({
      method: "Debugger.paused",
      params: {
        reason: "instrumentation",
        hitBreakpoints: ["gate"],
        data: { scriptId: "imported" },
        callFrames: [{ location: { scriptId: "imported" } }],
      },
    }),
  );
  // Queue a real boundary behind its imported-script admission; no polling or sleep.
  handlers.forEach((handler) =>
    handler({
      method: "Debugger.paused",
      params: {
        reason: "other",
        hitBreakpoints: ["boundary"],
        callFrames: [{ callFrameId: "frame", location: selected.location }],
      },
    }),
  );
  expect((await refused).message).toContain("guard rejected");
  expect(boundary).not.toHaveBeenCalled();
  expect(calls.indexOf("Debugger.getScriptSource")).toBeLessThan(
    calls.indexOf("Debugger.setBreakpoint"),
  );
  expect(calls.filter((method) => method === "Debugger.resume")).toHaveLength(2);
  expect(transport.call).toHaveBeenCalledWith(
    "Debugger.evaluateOnCallFrame",
    expect.objectContaining({ throwOnSideEffect: true }),
  );
});

it("requires exact compiler correspondence and original source bytes, not nearest source positions", () => {
  const original = Buffer.from("const source = true;\n");
  const selected = {
    ...mapping("fresh"),
    location: { lineNumber: 0, columnNumber: 0 },
    sourceLocation: { lineNumber: 0, columnNumber: 0 },
    source: { ...file("source.ts"), sha256: createHash("sha256").update(original).digest("hex") },
  };
  const compilerMap = {
    version: 3,
    sources: [selected.sourceName],
    sourcesContent: [original.toString()],
    mappings: "AAAA",
  };
  expect(() => assertCompilerMapping(compilerMap, selected, original)).not.toThrow();
  expect(() =>
    assertCompilerMapping(
      compilerMap,
      { ...selected, location: { lineNumber: 0, columnNumber: 1 } },
      original,
    ),
  ).toThrow(/exact generated/i);
  expect(() =>
    assertCompilerMapping({ ...compilerMap, sourcesContent: ["changed"] }, selected, original),
  ).toThrow(/source bytes/);
  expect(() =>
    assertCompilerMapping(
      compilerMap,
      { ...selected, sourceLocation: { lineNumber: 1, columnNumber: 0 } },
      original,
    ),
  ).toThrow(/different original/);
});
