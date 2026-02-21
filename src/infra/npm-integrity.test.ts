import { describe, expect, it, vi } from "vitest";
import {
  resolveNpmIntegrityDrift,
  resolveNpmIntegrityDriftWithDefaultMessage,
} from "./npm-integrity.js";

describe("resolveNpmIntegrityDrift", () => {
  it("returns proceed=true when integrity is missing or unchanged", async () => {
    await expect(
      resolveNpmIntegrityDrift({
        spec: "@openclaw/test@1.0.0",
        expectedIntegrity: "sha512-same",
        resolution: { integrity: "sha512-same", resolvedAt: "2026-01-01T00:00:00.000Z" },
        createPayload: () => "unused",
      }),
    ).resolves.toEqual({ proceed: true });

    await expect(
      resolveNpmIntegrityDrift({
        spec: "@openclaw/test@1.0.0",
        expectedIntegrity: "sha512-same",
        resolution: { resolvedAt: "2026-01-01T00:00:00.000Z" },
        createPayload: () => "unused",
      }),
    ).resolves.toEqual({ proceed: true });
  });

  it("uses callback on integrity drift", async () => {
    const onIntegrityDrift = vi.fn(async () => false);
    const result = await resolveNpmIntegrityDrift({
      spec: "@openclaw/test@1.0.0",
      expectedIntegrity: "sha512-old",
      resolution: {
        integrity: "sha512-new",
        resolvedAt: "2026-01-01T00:00:00.000Z",
      },
      createPayload: ({ expectedIntegrity, actualIntegrity }) => ({
        expectedIntegrity,
        actualIntegrity,
      }),
      onIntegrityDrift,
    });

    expect(onIntegrityDrift).toHaveBeenCalledWith({
      expectedIntegrity: "sha512-old",
      actualIntegrity: "sha512-new",
    });
    expect(result.proceed).toBe(false);
    expect(result.integrityDrift).toEqual({
      expectedIntegrity: "sha512-old",
      actualIntegrity: "sha512-new",
    });
  });

  it("warns by default when no callback is provided", async () => {
    const warn = vi.fn();
    const result = await resolveNpmIntegrityDrift({
      spec: "@openclaw/test@1.0.0",
      expectedIntegrity: "sha512-old",
      resolution: {
        integrity: "sha512-new",
        resolvedAt: "2026-01-01T00:00:00.000Z",
      },
      createPayload: ({ spec }) => ({ spec }),
      warn,
    });

    expect(warn).toHaveBeenCalledWith({ spec: "@openclaw/test@1.0.0" });
    expect(result.proceed).toBe(true);
  });

  it("formats default warning and abort error messages", async () => {
    const warn = vi.fn();
    const warningResult = await resolveNpmIntegrityDriftWithDefaultMessage({
      spec: "@openclaw/test@1.0.0",
      expectedIntegrity: "sha512-old",
      resolution: {
        integrity: "sha512-new",
        resolvedSpec: "@openclaw/test@1.0.0",
        resolvedAt: "2026-01-01T00:00:00.000Z",
      },
      warn,
    });
    expect(warningResult.error).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "Integrity drift detected for @openclaw/test@1.0.0: expected sha512-old, got sha512-new",
    );

    const abortResult = await resolveNpmIntegrityDriftWithDefaultMessage({
      spec: "@openclaw/test@1.0.0",
      expectedIntegrity: "sha512-old",
      resolution: {
        integrity: "sha512-new",
        resolvedSpec: "@openclaw/test@1.0.0",
        resolvedAt: "2026-01-01T00:00:00.000Z",
      },
      onIntegrityDrift: async () => false,
    });
    expect(abortResult.error).toBe(
      "aborted: npm package integrity drift detected for @openclaw/test@1.0.0",
    );
  });
});
