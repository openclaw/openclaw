import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listBaselines } from "../baseline/capture.js";
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
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.OPENCLAW_STATE_DIR;
    vi.mocked(captureBaseline).mockClear();
  });

  it("captures real baseline and probe evidence for the diagnose payload", async () => {
    const payload = await buildDiagnoseJson({ timeoutMs: 0 }, {} as RuntimeEnv);

    expect(payload.baselines.latest).toBe("diagnose-latest");
    expect(payload.baselines.current.timestamp).toEqual(expect.any(String));
    expect(listBaselines()).toContain("diagnose-latest");
    expect(
      listCachedProbes().some((probe) => probe.type === "plugin" && probe.id === "contracts"),
    ).toBe(true);
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
