import { describe, expect, it } from "vitest";
import { OPENCLAW_AUTO_NODE_EXTRA_CA_CERTS } from "../bootstrap/node-startup-env.js";
import { snapshotNodeWorkerEnv } from "./node-worker-environment.js";

const AUTO_CA = OPENCLAW_AUTO_NODE_EXTRA_CA_CERTS;
const SYSTEM_CA = "/etc/ssl/certs/ca-certificates.crt";
const CUSTOM_CA = "/session/private-ca.pem";

describe("snapshotNodeWorkerEnv", () => {
  it("omits an automatically injected host CA for a container launch", () => {
    const snapshot = snapshotNodeWorkerEnv(
      { NODE_EXTRA_CA_CERTS: SYSTEM_CA, [AUTO_CA]: SYSTEM_CA },
      undefined,
      { excludeAutomaticCa: true },
    );

    expect(snapshot.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(snapshot[AUTO_CA]).toBeUndefined();
  });

  it("keeps an automatically injected host CA for a host-process worker", () => {
    const snapshot = snapshotNodeWorkerEnv({
      NODE_EXTRA_CA_CERTS: SYSTEM_CA,
      [AUTO_CA]: SYSTEM_CA,
    });

    expect(snapshot.NODE_EXTRA_CA_CERTS).toBe(SYSTEM_CA);
  });

  it("preserves an explicit custom CA for a container launch", () => {
    const snapshot = snapshotNodeWorkerEnv({ NODE_EXTRA_CA_CERTS: CUSTOM_CA }, undefined, {
      excludeAutomaticCa: true,
    });

    expect(snapshot.NODE_EXTRA_CA_CERTS).toBe(CUSTOM_CA);
  });

  it("preserves a CA when automatic provenance does not match", () => {
    const snapshot = snapshotNodeWorkerEnv(
      { NODE_EXTRA_CA_CERTS: CUSTOM_CA, [AUTO_CA]: SYSTEM_CA },
      undefined,
      { excludeAutomaticCa: true },
    );

    expect(snapshot.NODE_EXTRA_CA_CERTS).toBe(CUSTOM_CA);
  });
});
