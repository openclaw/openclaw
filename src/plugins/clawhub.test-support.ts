import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { expect, vi, type Mock } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ClawHubInstallErrorCode } from "./clawhub-error-codes.js";

export const DEMO_ARCHIVE_INTEGRITY = "sha256-qerEjGEpvES2+Tyan0j2xwDRkbcnmh4ZFfKN9vWbsa8=";
export const DEMO_ARCHIVE_SHA256 =
  "a9eac48c6129bc44b6f93c9a9f48f6c700d191b7279a1e1915f28df6f59bb1af";
export const DEMO_CLAWPACK_SHA256 = "a".repeat(64);
export const DEMO_CLAWPACK_INTEGRITY = `sha256-${Buffer.from(DEMO_CLAWPACK_SHA256, "hex").toString(
  "base64",
)}`;
export const DEMO_PLUGIN_ARCHIVE_ENTRIES = {
  "package.json": JSON.stringify({
    name: "demo",
    version: "2026.3.22",
    openclaw: { extensions: ["./index.js"] },
  }),
  "openclaw.plugin.json": JSON.stringify({ id: "demo", configSchema: { type: "object" } }),
  "index.js": "export default { register() {} };\n",
};

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export type ClawHubArchiveFile = ReturnType<typeof clawHubArchiveFile>;

export function clawHubArchiveFile(filePath: string, contents: string) {
  return { path: filePath, size: Buffer.byteLength(contents), sha256: sha256Hex(contents) };
}

export function createClawHubArchiveFactory(
  registerCleanup: Parameters<typeof useAutoCleanupTempDirTracker>[0],
) {
  const tempDirs = useAutoCleanupTempDirTracker(registerCleanup);
  return async function createClawHubArchive(entries: Record<string, string>) {
    const dir = tempDirs.make("openclaw-clawhub-archive-");
    const archivePath = path.join(dir, "archive.zip");
    const zip = new JSZip();
    for (const [filePath, contents] of Object.entries(entries)) {
      zip.file(filePath, contents);
    }
    const archiveBytes = await zip.generateAsync({ type: "nodebuffer" });
    await fs.writeFile(archivePath, archiveBytes);
    return {
      archivePath,
      integrity: `sha256-${createHash("sha256").update(archiveBytes).digest("base64")}`,
    };
  };
}

export async function setClawHubArchiveEntryMode(
  archivePath: string,
  entryName: string,
  mode: number,
) {
  const bytes = await fs.readFile(archivePath);
  let offset = bytes.readUInt32LE(bytes.length - 6);
  while (bytes.readUInt32LE(offset) === 0x02014b50) {
    const nameLength = bytes.readUInt16LE(offset + 28);
    if (bytes.subarray(offset + 46, offset + 46 + nameLength).toString() === entryName) {
      // Encode physical type bits directly; JSZip coerces some unsupported types to directories.
      bytes[offset + 5] = 3;
      bytes.writeUInt32LE(mode * 0x10000, offset + 38);
      await fs.writeFile(archivePath, bytes);
      return;
    }
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  throw new Error(`Archive fixture is missing ${entryName}`);
}

export function createLoggerSpies(): Record<"info" | "warn", Mock<(message: string) => void>> {
  return { info: vi.fn(), warn: vi.fn() };
}

export function clawHubPackageDetail(overrides: Record<string, unknown> = {}) {
  return {
    package: {
      name: "demo",
      family: "code-plugin",
      channel: "official",
      isOfficial: true,
      compatibility: { pluginApiRange: ">=2026.3.22", minGatewayVersion: "2026.3.0" },
      ...overrides,
    },
  };
}

type MockWithCalls = {
  mock: {
    calls: readonly (readonly unknown[])[];
  };
};

export type PackageLookupCall = Partial<
  Record<"artifact" | "baseUrl" | "name" | "version", string>
>;

export type ArchiveInstallCall = Partial<
  Parameters<typeof import("./install.js").installPluginFromArchive>[0]
>;

type InstallResult = Awaited<ReturnType<typeof import("./clawhub.js").installPluginFromClawHub>>;
type InstallSuccess = Extract<InstallResult, { ok: true }>;
type InstallFailure = Extract<InstallResult, { ok: false }> & {
  version?: string;
  warning?: string;
};

export function mockCallArg(mock: MockWithCalls, callIndex = 0, argIndex = 0): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call || call.length <= argIndex) {
    throw new Error(`Expected mock call ${callIndex} argument ${argIndex}`);
  }
  return call[argIndex];
}

export function expectInstallSuccess(result: unknown): InstallSuccess {
  expect((result as { ok?: unknown }).ok).toBe(true);
  return result as InstallSuccess;
}

export function expectInstallFailure(result: unknown): InstallFailure {
  expect((result as { ok?: unknown }).ok).toBe(false);
  return result as InstallFailure;
}

export function expectInstallFailureFields(
  result: unknown,
  code: ClawHubInstallErrorCode,
  error: string,
) {
  expect(result).toMatchObject({ ok: false, code, error });
}

export function expectSuccessfulClawHubInstall(
  result: unknown,
  expected: { clawhubChannel?: string } = {},
) {
  expect(result).toMatchObject({
    ok: true,
    pluginId: "demo",
    version: "2026.3.22",
    clawhub: {
      source: "clawhub",
      clawhubPackage: "demo",
      clawhubFamily: "code-plugin",
      clawhubChannel: expected.clawhubChannel ?? "official",
      integrity: DEMO_ARCHIVE_INTEGRITY,
    },
  });
}
