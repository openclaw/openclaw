import { describe, expect, it } from "vitest";
import { needsCandidateManagedServiceStop } from "./update-command-legacy-service-stop.js";
import type { PreManagedServiceStop } from "./update-command-service-context-types.js";

const uninspected: PreManagedServiceStop = {
  stopped: false,
  inspected: false,
  runtimeInspected: false,
  running: false,
  serviceMutationAllowed: false,
  serviceUpdateVerdict: { kind: "unavailable", message: "inspection unavailable" },
};

describe("needsCandidateManagedServiceStop", () => {
  it("stops a running service that a legacy parent could not inspect", () => {
    expect(
      needsCandidateManagedServiceStop({
        preManagedServiceStop: uninspected,
        shouldRestart: true,
        mode: "npm",
      }),
    ).toBe(true);
  });

  it.each([
    { name: "restart disabled", shouldRestart: false, stop: uninspected, mode: "npm" as const },
    {
      name: "unknown install mode",
      shouldRestart: true,
      stop: uninspected,
      mode: "unknown" as const,
    },
    { name: "no transferred state", shouldRestart: true, stop: undefined, mode: "npm" as const },
    {
      name: "parent inspected the service",
      shouldRestart: true,
      stop: {
        ...uninspected,
        inspected: true,
        serviceUpdateVerdict: { kind: "unresolved" as const, root: "/r", fingerprint: "f" },
      },
      mode: "npm" as const,
    },
    {
      name: "parent already stopped the service",
      shouldRestart: true,
      stop: { ...uninspected, stopped: true },
      mode: "npm" as const,
    },
    {
      name: "parent suspended Windows autostart",
      shouldRestart: true,
      stop: uninspected,
      mode: "npm" as const,
      windowsTaskAutoStartSuspended: true,
    },
  ])("leaves the transferred state alone when $name", (params) => {
    expect(
      needsCandidateManagedServiceStop({
        preManagedServiceStop: params.stop,
        shouldRestart: params.shouldRestart,
        mode: params.mode,
        windowsTaskAutoStartSuspended: params.windowsTaskAutoStartSuspended,
      }),
    ).toBe(false);
  });
});
