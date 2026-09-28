import { describe, expect, it } from "vitest";
import { requireWorkerLease } from "./service-validation.js";

const transports = [
  { kind: "node", endpoint: { node: { deviceId: "node-1" } } },
  {
    kind: "ssh",
    endpoint: {
      ssh: {
        host: "worker.example.test",
        port: 22,
        user: "openclaw",
        hostKey: "ssh-ed25519 AAAA",
        keyRef: { source: "file", provider: "worker-keys", id: "/development-key" },
      },
    },
  },
];

describe.each(transports)("$kind worker lease host classification", ({ endpoint }) => {
  it.each([true, false])("preserves the explicit provider fact %s", (sharedHost) => {
    expect(requireWorkerLease({ leaseId: "lease-1", ...endpoint, sharedHost })).toEqual({
      leaseId: "lease-1",
      ...endpoint,
      sharedHost,
    });
  });

  it.each([{}, { sharedHost: undefined }])(
    "does not infer omitted classification from %j",
    (input) => {
      expect(requireWorkerLease({ leaseId: "lease-1", ...endpoint, ...input })).toEqual({
        leaseId: "lease-1",
        ...endpoint,
      });
    },
  );

  it.each([null, 0, "false", {}, []].map((sharedHost) => ({ sharedHost })))(
    "rejects non-boolean classification $sharedHost",
    ({ sharedHost }) => {
      expect(() => requireWorkerLease({ leaseId: "lease-1", ...endpoint, sharedHost })).toThrow(
        "Worker provider returned an invalid provision result",
      );
    },
  );
});
