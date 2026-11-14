import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { adoptCandidateManagedServiceStop } from "../../infra/update-candidate-predecessor-stop.js";
import * as updateRunReader from "../../infra/update-run-reader.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import type { PreManagedServiceStop } from "./update-command-service-context-types.js";
import * as serviceMaintenance from "./update-command-service-maintenance.js";

const uninspected: PreManagedServiceStop = {
  stopped: false,
  inspected: false,
  runtimeInspected: false,
  running: false,
  serviceUpdateVerdict: { kind: "unavailable", message: "inspection unavailable" },
};

type AdoptionParams = Parameters<typeof adoptCandidateManagedServiceStop>[0];
let params: AdoptionParams;

beforeEach(() => {
  params = {
    transferred: uninspected,
    shouldRestart: true,
    mode: "npm",
    status: "ok",
    runId: "synthetic-run",
    ledger: {},
    root: "/synthetic",
    assertCurrent: vi.fn(),
    onStopped: vi.fn(),
    onStep: vi.fn(),
  };
  mockProcessPlatform("linux");
  vi.spyOn(updateRunReader, "getUpdateRunAsync").mockResolvedValue(undefined);
  vi.spyOn(serviceMaintenance, "maybeStopManagedServiceBeforeMutableUpdate").mockResolvedValue(
    uninspected,
  );
});

afterEach(() => vi.restoreAllMocks());

it.each<[string, Partial<AdoptionParams>]>([
  ["restart disabled", { shouldRestart: false }],
  ["unknown install mode", { mode: "unknown" }],
  ["no transferred state", { transferred: undefined }],
  ["parent inspected the service", { transferred: { ...uninspected, inspected: true } }],
  [
    "not an unavailable legacy verdict",
    {
      transferred: {
        ...uninspected,
        serviceUpdateVerdict: { kind: "unresolved", root: "/r", fingerprint: "f" },
      },
    },
  ],
  ["parent already stopped the service", { transferred: { ...uninspected, stopped: true } }],
  ["parent suspended Windows autostart", { windowsTaskAutoStartSuspended: true }],
])("leaves the transferred state alone when %s", async (_name, overrides) => {
  Object.assign(params, overrides);
  await expect(adoptCandidateManagedServiceStop(params)).resolves.toEqual({
    stopped: params.transferred,
    restartRequired: false,
  });
  expect(serviceMaintenance.maybeStopManagedServiceBeforeMutableUpdate).not.toHaveBeenCalled();
  expect(params.onStopped).not.toHaveBeenCalled();
  expect(params.onStep).not.toHaveBeenCalled();
});

it("stops a transferred uninspected service when restart is allowed", async () => {
  const stopped = { ...uninspected, stopped: true, inspected: true };
  vi.mocked(serviceMaintenance.maybeStopManagedServiceBeforeMutableUpdate).mockImplementation(
    async (request) => {
      request.onStopped?.(stopped);
      return stopped;
    },
  );
  await expect(adoptCandidateManagedServiceStop(params)).resolves.toEqual({
    stopped,
    restartRequired: false,
  });
  expect(
    serviceMaintenance.maybeStopManagedServiceBeforeMutableUpdate,
  ).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      root: "/synthetic",
      phase: "prepare",
      shouldRestart: true,
      assertCurrent: params.assertCurrent,
    }),
  );
  expect(params.onStopped).toHaveBeenCalledExactlyOnceWith(stopped);
  expect(params.onStep).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ name: "managed-service", exitCode: 0 }),
  );
});
