import { describe, expect, it } from "vitest";
import { OPENCLAW_AUTO_NODE_EXTRA_CA_CERTS } from "../bootstrap/node-startup-env.js";
import { snapshotNodeWorkerEnv } from "./node-worker-environment.js";

const AUTO_CA = OPENCLAW_AUTO_NODE_EXTRA_CA_CERTS;

describe("snapshotNodeWorkerEnv", () => {
  it("omits an automatically injected host CA path", () => {
    const path = "/etc/ssl/certs/ca-certificates.crt";

    const snapshot = snapshotNodeWorkerEnv({
      NODE_EXTRA_CA_CERTS: path,
      [AUTO_CA]: path,
    });

    expect(snapshot.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(snapshot[AUTO_CA]).toBeUndefined();
  });

  it("preserves an explicit custom CA path", () => {
    const path = "/session/private-ca.pem";

    const snapshot = snapshotNodeWorkerEnv({ NODE_EXTRA_CA_CERTS: path });

    expect(snapshot.NODE_EXTRA_CA_CERTS).toBe(path);
  });

  it("preserves a CA path when automatic provenance does not match", () => {
    const snapshot = snapshotNodeWorkerEnv({
      NODE_EXTRA_CA_CERTS: "/session/private-ca.pem",
      [AUTO_CA]: "/etc/ssl/certs/ca-certificates.crt",
    });

    expect(snapshot.NODE_EXTRA_CA_CERTS).toBe("/session/private-ca.pem");
  });
});
