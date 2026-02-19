import { beforeEach, describe, expect, it, vi } from "vitest";
import { packNpmSpecToArchive, withTempDir } from "./install-source-utils.js";
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
  beforeEach(() => {
    vi.mocked(packNpmSpecToArchive).mockReset();
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
    vi.mocked(packNpmSpecToArchive).mockResolvedValue({
      ok: true,
      archivePath: "/tmp/openclaw-test.tgz",
      metadata: {
        name: "@openclaw/test",
        version: "1.0.0",
        resolvedSpec: "@openclaw/test@1.0.0",
        integrity: "sha512-same",
      },
    });
    const installFromArchive = vi.fn(async () => ({ ok: true as const, target: "done" }));

    const result = await installFromNpmSpecArchive({
      tempDirPrefix: "openclaw-test-",
      spec: "@openclaw/test@1.0.0",
      timeoutMs: 1000,
      expectedIntegrity: "sha512-same",
      installFromArchive,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.installResult).toEqual({ ok: true, target: "done" });
    expect(result.integrityDrift).toBeUndefined();
    expect(result.npmResolution.resolvedSpec).toBe("@openclaw/test@1.0.0");
    expect(result.npmResolution.resolvedAt).toBeTruthy();
    expect(installFromArchive).toHaveBeenCalledWith({ archivePath: "/tmp/openclaw-test.tgz" });
  });

  it("aborts when integrity drift callback rejects drift", async () => {
    vi.mocked(packNpmSpecToArchive).mockResolvedValue({
      ok: true,
      archivePath: "/tmp/openclaw-test.tgz",
      metadata: {
        resolvedSpec: "@openclaw/test@1.0.0",
        integrity: "sha512-new",
      },
    });
    const installFromArchive = vi.fn(async () => ({ ok: true as const }));

    const result = await installFromNpmSpecArchive({
      tempDirPrefix: "openclaw-test-",
      spec: "@openclaw/test@1.0.0",
      timeoutMs: 1000,
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
});
