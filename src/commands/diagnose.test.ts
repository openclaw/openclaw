import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listBaselines } from "../baseline/capture.js";
import { resetConfigRuntimeState } from "../config/config.js";
import { REDACTED_SENTINEL } from "../config/redact-snapshot.js";
import { listCachedProbes } from "../probes/cache.js";
import type { RuntimeEnv } from "../runtime.js";
import { buildDiagnoseJson } from "./diagnose.js";

vi.mock("../baseline/capture.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../baseline/capture.js")>();
  return {
    ...actual,
    captureBaseline: vi.fn(actual.captureBaseline),
  };
});

import { captureBaseline } from "../baseline/capture.js";

describe("diagnose command", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-diagnose-test-"));
    process.env.OPENCLAW_STATE_DIR = tempDir;
    resetConfigRuntimeState();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.OPENCLAW_STATE_DIR;
    resetConfigRuntimeState();
    vi.mocked(captureBaseline).mockClear();
  });

  it("captures real baseline and probe evidence for the diagnose payload", async () => {
    const payload = await buildDiagnoseJson({ timeoutMs: 0 }, {} as RuntimeEnv);

    expect(payload.schemaVersion).toBe("openclaw-diagnose/v1");
    expect(payload.redaction).toEqual({
      secretsIncluded: false,
      rawConfigIncluded: false,
      rawEnvIncluded: false,
    });
    expect(payload.persistence).toEqual({
      writesBaseline: true,
      writesProbeCache: true,
      writesIncidentLedger: true,
    });
    expect(payload.baselines.latest).toBe("diagnose-latest");
    expect(payload.baselines.current.timestamp).toEqual(expect.any(String));
    expect(listBaselines()).toContain("diagnose-latest");
    expect(
      listCachedProbes().some((probe) => probe.type === "plugin" && probe.id === "contracts"),
    ).toBe(true);
  });

  it("keeps gateway auth and raw secret material out of the operator JSON contract", async () => {
    const payload = await buildDiagnoseJson({ timeoutMs: 0 }, {} as RuntimeEnv);
    const serialized = JSON.stringify(payload);

    expect(payload.status.gateway).not.toHaveProperty("auth");
    expect(serialized).not.toContain("gateway.auth");
    expect(serialized).not.toMatch(/token|password|api[_-]?key/i);
    expect(payload.actions.unsafe).toEqual(
      expect.arrayContaining([
        "openclaw doctor --fix",
        "openclaw gateway restart",
        "openclaw plugins update --all",
      ]),
    );
  });

  it("redacts remote gateway URL userinfo and sensitive query params from diagnose JSON", async () => {
    fs.writeFileSync(
      path.join(tempDir, "openclaw.json"),
      JSON.stringify({
        gateway: {
          mode: "remote",
          remote: {
            url: "ws://user:pass@example.test/ws?token=superprivate&safe=visible",
          },
        },
      }),
      "utf-8",
    );

    const payload = await buildDiagnoseJson({ timeoutMs: 0 }, {} as RuntimeEnv);
    const serialized = JSON.stringify(payload);

    expect(payload.status.gateway).toMatchObject({
      mode: "remote",
      remote: {
        url: REDACTED_SENTINEL,
      },
    });
    expect(serialized).not.toContain("user:pass");
    expect(serialized).not.toContain("token=superprivate");
    expect(serialized).not.toContain("superprivate");
  });

  it("threads diagnose timeout into baseline gateway probes", async () => {
    await buildDiagnoseJson({ timeoutMs: 1234 }, {} as RuntimeEnv);

    expect(captureBaseline).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayTimeoutMs: 1234,
      }),
    );
  });
});
