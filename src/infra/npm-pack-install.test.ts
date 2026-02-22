import { beforeEach, describe, expect, it, vi } from "vitest";
import { packNpmSpecToArchive, withTempDir } from "./install-source-utils.js";
import type { NpmIntegrityDriftPayload } from "./npm-integrity.js";
import { installFromNpmSpecArchive } from "./npm-pack-install.js";

vi.mock("./install-source-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./install-source-utils.js")>();
  return {
    ...actual,
    withTempDir: vi.fn(async (_prefix: string, fn: (tmpDir: string) => Promise<unknown>) => {
      return await fn("/tmp/openclaw-npm-pack-install-test");
    }),
    packNpmSpecToArchive: vi.fn(),
  };
});

describe("installFromNpmSpecArchive", () => {
  const baseSpec = "@openclaw/test@1.0.0";
  const baseArchivePath = "/tmp/openclaw-test.tgz";

  const mockPackedSuccess = (overrides?: {
    resolvedSpec?: string;
    integrity?: string;
    name?: string;
    version?: string;
  }) => {
    vi.mocked(packNpmSpecToArchive).mockResolvedValue({
      ok: true,
      archivePath: baseArchivePath,
      metadata: {
        resolvedSpec: overrides?.resolvedSpec ?? baseSpec,
        integrity: overrides?.integrity ?? "sha512-same",
        ...(overrides?.name ? { name: overrides.name } : {}),
        ...(overrides?.version ? { version: overrides.version } : {}),
      },
    });
  };

  const runInstall = async (overrides: {
    expectedIntegrity?: string;
    onIntegrityDrift?: (payload: NpmIntegrityDriftPayload) => boolean | Promise<boolean>;
    warn?: (message: string) => void;
    installFromArchive: (params: {
      archivePath: string;
    }) => Promise<{ ok: boolean; [k: string]: unknown }>;
  }) =>
    await installFromNpmSpecArchive({
      tempDirPrefix: "openclaw-test-",
      spec: baseSpec,
      timeoutMs: 1000,
      expectedIntegrity: overrides.expectedIntegrity,
      onIntegrityDrift: overrides.onIntegrityDrift,
      warn: overrides.warn,
      installFromArchive: overrides.installFromArchive,
    });

  const expectWrappedOkResult = (
    result: Awaited<ReturnType<typeof runInstall>>,
    installResult: Record<string, unknown>,
  ) => {
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected ok result");
    }
    expect(result.installResult).toEqual(installResult);
    return result;
  };

  beforeEach(() => {
    vi.mocked(packNpmSpecToArchive).mockClear();
    vi.mocked(withTempDir).mockClear();
  });

  it("returns pack errors without invoking installer", async () => {
    vi.mocked(packNpmSpecToArchive).mockResolvedValue({ ok: false, error: "pack failed" });
    const installFromArchive = vi.fn(async () => ({ ok: true as const }));

    const result = await installFromNpmSpecArchive({
      tempDirPrefix: "openclaw-test-",
      spec: "@openclaw/test@1.0.0",
      timeoutMs: 1000,
      installFromArchive,
    });

    expect(result).toEqual({ ok: false, error: "pack failed" });
    expect(installFromArchive).not.toHaveBeenCalled();
    expect(withTempDir).toHaveBeenCalledWith("openclaw-test-", expect.any(Function));
  });

  it("returns resolution metadata and installer result on success", async () => {
    mockPackedSuccess({ name: "@openclaw/test", version: "1.0.0" });
    const installFromArchive = vi.fn(async () => ({ ok: true as const, target: "done" }));

    const result = await runInstall({
      expectedIntegrity: "sha512-same",
      installFromArchive,
    });

    const okResult = expectWrappedOkResult(result, { ok: true, target: "done" });
    expect(okResult.integrityDrift).toBeUndefined();
    expect(okResult.npmResolution.resolvedSpec).toBe("@openclaw/test@1.0.0");
    expect(okResult.npmResolution.resolvedAt).toBeTruthy();
    expect(installFromArchive).toHaveBeenCalledWith({ archivePath: "/tmp/openclaw-test.tgz" });
  });

  it("proceeds when integrity drift callback accepts drift", async () => {
    mockPackedSuccess({ integrity: "sha512-new" });
    const onIntegrityDrift = vi.fn(async () => true);
    const installFromArchive = vi.fn(async () => ({ ok: true as const, id: "plugin-accept" }));

    const result = await runInstall({
      expectedIntegrity: "sha512-old",
      onIntegrityDrift,
      installFromArchive,
    });

    const okResult = expectWrappedOkResult(result, { ok: true, id: "plugin-accept" });
    expect(okResult.integrityDrift).toEqual({
      expectedIntegrity: "sha512-old",
      actualIntegrity: "sha512-new",
    });
    expect(onIntegrityDrift).toHaveBeenCalledTimes(1);
  });

  it("aborts when integrity drift callback rejects drift", async () => {
    mockPackedSuccess({ integrity: "sha512-new" });
    const installFromArchive = vi.fn(async () => ({ ok: true as const }));

    const result = await runInstall({
      expectedIntegrity: "sha512-old",
      onIntegrityDrift: async () => false,
      installFromArchive,
    });

    expect(result).toEqual({
      ok: false,
      error: "aborted: npm package integrity drift detected for @openclaw/test@1.0.0",
    });
    expect(installFromArchive).not.toHaveBeenCalled();
  });

  it("warns and proceeds on drift when no callback is configured", async () => {
    mockPackedSuccess({ integrity: "sha512-new" });
    const warn = vi.fn();
    const installFromArchive = vi.fn(async () => ({ ok: true as const, id: "plugin-1" }));

    const result = await runInstall({
      expectedIntegrity: "sha512-old",
      warn,
      installFromArchive,
    });

    const okResult = expectWrappedOkResult(result, { ok: true, id: "plugin-1" });
    expect(okResult.integrityDrift).toEqual({
      expectedIntegrity: "sha512-old",
      actualIntegrity: "sha512-new",
    });
    expect(warn).toHaveBeenCalledWith(
      "Integrity drift detected for @openclaw/test@1.0.0: expected sha512-old, got sha512-new",
    );
  });

  it("returns installer failures to callers for domain-specific handling", async () => {
    mockPackedSuccess({ integrity: "sha512-same" });
    const installFromArchive = vi.fn(async () => ({ ok: false as const, error: "install failed" }));

    const result = await runInstall({
      expectedIntegrity: "sha512-same",
      installFromArchive,
    });

    const okResult = expectWrappedOkResult(result, { ok: false, error: "install failed" });
    expect(okResult.integrityDrift).toBeUndefined();
  });
});
