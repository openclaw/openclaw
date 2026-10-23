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
  serviceMutationAllowed: false,
  serviceUpdateVerdict: { kind: "unavailable", message: "inspection unavailable" },
};

type AdoptionParams = Parameters<typeof adoptCandidateManagedServiceStop>[0];

function adoptionParams(overrides: Partial<AdoptionParams> = {}): AdoptionParams {
  return {
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
    ...overrides,
  };
}

beforeEach(() => {
  mockProcessPlatform("linux");
  vi.spyOn(updateRunReader, "getUpdateRunAsync").mockResolvedValue(undefined);
  vi.spyOn(serviceMaintenance, "maybeStopManagedServiceBeforeMutableUpdate").mockResolvedValue(
    uninspected,
  );
});

afterEach(() => vi.restoreAllMocks());

it.each([
  { name: "restart disabled", shouldRestart: false },
  { name: "unknown install mode", mode: "unknown" as const },
  { name: "no transferred state", transferred: undefined },
  {
    name: "parent inspected the service",
    transferred: {
      ...uninspected,
      inspected: true,
    },
  },
  {
    name: "not an unavailable legacy verdict",
    transferred: {
      ...uninspected,
      serviceUpdateVerdict: { kind: "unresolved" as const, root: "/r", fingerprint: "f" },
    },
  },
  {
    name: "parent already stopped the service",
    transferred: { ...uninspected, stopped: true },
  },
  {
    name: "parent suspended Windows autostart",
    windowsTaskAutoStartSuspended: true,
  },
])("leaves the transferred state alone when $name", async ({ name: _name, ...overrides }) => {
  const params = adoptionParams(overrides);
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
    async (params) => {
      params.onStopped?.(stopped);
      return stopped;
    },
  );
  const params = adoptionParams();

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
