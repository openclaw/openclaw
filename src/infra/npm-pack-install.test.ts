// Covers npm package archive installation helpers.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { packNpmSpecToArchive } from "./install-source-utils.js";
import {
  finalizeNpmSpecArchiveInstall,
  installFromNpmSpecArchiveWithInstaller,
} from "./npm-pack-install.js";

vi.mock("./install-source-utils.js", async () => {
  const actual = await vi.importActual<typeof import("./install-source-utils.js")>(
    "./install-source-utils.js",
  );
  return {
    ...actual,
    withTempDir: vi.fn(async (_prefix: string, fn: (tmpDir: string) => Promise<unknown>) => {
      return await fn("/tmp/openclaw-npm-pack-install-test");
    }),
    packNpmSpecToArchive: vi.fn(),
  };
});

describe("installFromNpmSpecArchiveWithInstaller", () => {
  beforeEach(() => {
    vi.mocked(packNpmSpecToArchive).mockClear();
  });

  it("passes archive path and installer params to installFromArchive", async () => {
    vi.mocked(packNpmSpecToArchive).mockResolvedValue({
      ok: true,
      archivePath: "/tmp/openclaw-plugin.tgz",
      metadata: {
        resolvedSpec: "@openclaw/voice-call@1.0.0",
        integrity: "sha512-same",
      },
    });
    const installFromArchive = vi.fn(
      async (_params: { archivePath: string; pluginId: string }) =>
        ({ ok: true as const, pluginId: "voice-call" }) as const,
    );

    const result = await installFromNpmSpecArchiveWithInstaller({
      tempDirPrefix: "openclaw-test-",
      spec: "@openclaw/voice-call@1.0.0",
      timeoutMs: 1000,
      installFromArchive,
      archiveInstallParams: { pluginId: "voice-call" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(installFromArchive).toHaveBeenCalledWith({
      archivePath: "/tmp/openclaw-plugin.tgz",
      pluginId: "voice-call",
    });
    expect(result.installResult).toEqual({ ok: true, pluginId: "voice-call" });
  });
});

describe("finalizeNpmSpecArchiveInstall", () => {
  it("returns top-level flow errors unchanged", () => {
    const result = finalizeNpmSpecArchiveInstall<{ ok: true } | { ok: false; error: string }>({
      ok: false,
      error: "pack failed",
    });

    expect(result).toEqual({ ok: false, error: "pack failed" });
  });

  it("returns install errors unchanged", () => {
    const result = finalizeNpmSpecArchiveInstall<{ ok: true } | { ok: false; error: string }>({
      ok: true,
      installResult: { ok: false, error: "install failed" },
      npmResolution: {
        resolvedSpec: "@openclaw/test@1.0.0",
        integrity: "sha512-same",
        resolvedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    expect(result).toEqual({ ok: false, error: "install failed" });
  });

  it("attaches npm metadata to successful install results", () => {
    const result = finalizeNpmSpecArchiveInstall<
      { ok: true; pluginId: string } | { ok: false; error: string }
    >({
      ok: true,
      installResult: { ok: true, pluginId: "voice-call" },
      npmResolution: {
        resolvedSpec: "@openclaw/voice-call@1.0.0",
        integrity: "sha512-same",
        resolvedAt: "2026-01-01T00:00:00.000Z",
      },
      integrityDrift: {
        expectedIntegrity: "sha512-old",
        actualIntegrity: "sha512-same",
      },
    });

    expect(result).toEqual({
      ok: true,
      pluginId: "voice-call",
      npmResolution: {
        resolvedSpec: "@openclaw/voice-call@1.0.0",
        integrity: "sha512-same",
        resolvedAt: "2026-01-01T00:00:00.000Z",
      },
      integrityDrift: {
        expectedIntegrity: "sha512-old",
        actualIntegrity: "sha512-same",
      },
    });
  });
});
