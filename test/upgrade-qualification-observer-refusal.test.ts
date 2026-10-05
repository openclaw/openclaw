import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({
  spawn: vi.fn(),
  scan: vi.fn(),
  retain: vi.fn(),
  probe: vi.fn(),
  admitSession: vi.fn(),
  close: vi.fn(),
  logClose: vi.fn(),
  identity: {
    pid: 987654,
    parent: 0,
    group: 987654,
    startTime: "123",
    state: "S",
    cgroups: [],
    executable: "/qualification/node",
    argv: ["/qualification/node", "--inspect-brk=127.0.0.1:0", "/qualification/entry.mjs"],
  },
}));

vi.mock("node:child_process", () => ({ spawn: seams.spawn }));
vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: vi.fn(),
    open: vi.fn(async () => ({ write: vi.fn(), sync: vi.fn(), close: seams.logClose })),
  },
}));
// mock-isolation: Exercise refusal cleanup without reading real custody files or signaling real processes.
vi.mock("../scripts/lib/upgrade-qualification-observation-files.mjs", () => ({
  sha: vi.fn(() => "digest"),
  delay: vi.fn(async () => {}),
  bytes: vi.fn(async () => Buffer.from("{}")),
  retain: seams.retain,
  processIdentity: vi.fn(async () => ({ ...seams.identity })),
  inspectorEndpoint: vi.fn(async () => "ws://127.0.0.1/fixture"),
  verifyArtifacts: vi.fn(async () => {}),
  observedEntryPath: (mapping: { entry: { path: string } }) => mapping.entry.path,
  verifyObservedEntry: vi.fn(async () => undefined),
  probe: seams.probe,
  protectedInventory: vi.fn(async () => []),
  scan: seams.scan,
  alive: vi.fn(async () => true),
  assertObservationAudit: vi.fn(),
  assertCompilerMapping: vi.fn(),
  assertNativeObservationSelectors: vi.fn(() => ({ apply: {}, resume: {} })),
}));
// mock-isolation: Deliver the captured UUID and kill boundary without connecting to a real inspector.
vi.mock("../scripts/lib/upgrade-qualification-inspector.mjs", () => ({
  Transport: vi.fn(),
  connect: vi.fn(async () => ({ socket: { close: seams.close }, transport: { handlers: [] } })),
  admitSession: seams.admitSession,
}));

import { runHistoricalObservation } from "../scripts/lib/upgrade-qualification-observer.mjs";

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  seams.identity.state = "S";
});

it("preserves the stopped original process when pre-kill retained custody is absent", async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: seams.identity.pid,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
  seams.spawn.mockReturnValue(child);
  seams.scan.mockResolvedValue([seams.identity]).mockResolvedValueOnce([]);
  seams.probe.mockRejectedValue(
    new Error("Require actual original ledger/pointer retained custody before kill."),
  );
  const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
    if (signal === "SIGSTOP") {
      seams.identity.state = "T";
    }
    return true;
  });
  const originalRunId = "00000000-0000-4000-8000-000000000001";
  const artifact = { path: "/qualification/entry.mjs" };
  const mapping = {
    id: "fresh",
    phase: "fresh",
    entry: artifact,
    script: artifact,
    semanticAudit: artifact,
    sourceMap: artifact,
    source: artifact,
  };
  seams.admitSession.mockImplementation(async (options) => {
    await options.onCaptureRun(originalRunId, mapping, seams.identity);
    await options.onBoundary({
      identity: seams.identity,
      mapping,
      observedFacts: {},
      pause: { callFrames: [] },
      retained: false,
    });
  });
  const apply = ["/qualification/bootstrap", "--qualification-inspector"];
  await expect(
    runHistoricalObservation(
      {
        runId: "observation",
        observerFiles: [],
        artifacts: [],
        mappings: [mapping],
        protectedRoots: [],
        nativeBootstrap: { path: apply[0] },
        runtime: { path: seams.identity.executable },
        serviceCgroups: [],
        timeoutMs: 1000,
        apply,
        resume: ["/qualification/bootstrap", "--retained-run", "{{original-run-id}}"],
      },
      "/qualification/receipts",
    ),
  ).rejects.toThrow(/retained custody before kill/);

  expect(kill.mock.calls).toEqual([[seams.identity.pid, "SIGSTOP"]]);
  expect(child.kill).not.toHaveBeenCalled();
  expect(seams.spawn).toHaveBeenCalledTimes(1);
  expect(seams.spawn.mock.calls[0]?.[1]).toEqual(apply.slice(1));
  expect(seams.retain).toHaveBeenCalledWith("/qualification/receipts", "custody-refusal.json", {
    observationId: "observation",
    originalRunId,
    stoppedIdentities: [seams.identity],
    status: "stopped-preserved-no-crash-admission",
    qualificationPassed: false,
  });
  expect(seams.close).toHaveBeenCalled();
  expect(seams.logClose).toHaveBeenCalled();
});
