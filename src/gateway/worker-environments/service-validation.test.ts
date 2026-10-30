import { expect, it } from "vitest";
import { requireWorkerLease } from "./service-validation.js";

const nodeLease = { leaseId: "lease-1", node: { deviceId: "node-1" } };

it.each([
  { ...nodeLease, sharedHost: true },
  {
    leaseId: "lease-1",
    sharedHost: false,
    ssh: {
      host: "worker.example.test",
      port: 22,
      user: "openclaw",
      hostKey: "ssh-ed25519 AAAA",
      keyRef: { source: "file", provider: "worker-keys", id: "/development-key" },
    },
  },
])("preserves the explicit provider host classification $sharedHost", (lease) => {
  expect(requireWorkerLease(lease)).toEqual(lease);
});

it("does not infer omitted host classification", () => {
  expect(requireWorkerLease(nodeLease)).toEqual(nodeLease);
});

it.each([null, "false"])("rejects non-boolean host classification %j", (sharedHost) => {
  expect(() => requireWorkerLease({ ...nodeLease, sharedHost })).toThrow(
    "Worker provider returned an invalid provision result",
  );
});
