import { expect, it } from "vitest";
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

it.each([
  { name: "restart disabled", shouldRestart: false },
  { name: "unknown install mode", mode: "unknown" as const },
  { name: "no transferred state", preManagedServiceStop: undefined },
  {
    name: "parent inspected the service",
    preManagedServiceStop: {
      ...uninspected,
      inspected: true,
      serviceUpdateVerdict: { kind: "unresolved" as const, root: "/r", fingerprint: "f" },
    },
  },
  {
    name: "parent already stopped the service",
    preManagedServiceStop: { ...uninspected, stopped: true },
  },
  {
    name: "parent suspended Windows autostart",
    windowsTaskAutoStartSuspended: true,
  },
])("leaves the transferred state alone when $name", ({ name: _name, ...params }) => {
  expect(
    needsCandidateManagedServiceStop({
      preManagedServiceStop: uninspected,
      shouldRestart: true,
      mode: "npm",
      ...params,
    }),
  ).toBe(false);
});
