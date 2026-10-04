import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { scanPluginNpmArtifactSecurity } from "../../scripts/plugin-npm-security-scan.mts";

function writeTarString(header: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) {
    throw new Error(`Tar field is too long: ${value}`);
  }
  bytes.copy(header, offset);
}

function writeTarOctal(header: Buffer, offset: number, length: number, value: number): void {
  const raw = value.toString(8).padStart(length - 2, "0");
  writeTarString(header, offset, length, `${raw} \0`);
}

function tarEntry(path: string, value: string): Buffer {
  const content = Buffer.from(value, "utf8");
  const header = Buffer.alloc(512);
  writeTarString(header, 0, 100, path);
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, content.length);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeTarString(header, 257, 6, "ustar\0");
  writeTarString(header, 263, 2, "00");
  writeTarOctal(header, 329, 8, 0);
  writeTarOctal(header, 337, 8, 0);
  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  writeTarOctal(header, 148, 8, checksum);
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
  return Buffer.concat([header, content, padding]);
}

function packageTarball(
  packageName: string,
  files: Record<string, string>,
  manifest: Record<string, unknown> = {},
): Buffer {
  const entries = {
    "package/package.json": JSON.stringify({ name: packageName, version: "1.0.0", ...manifest }),
    "package/openclaw.plugin.json": JSON.stringify({ id: "example" }),
    ...Object.fromEntries(Object.entries(files).map(([path, value]) => [`package/${path}`, value])),
  };
  return gzipSync(
    Buffer.concat([
      ...Object.entries(entries).map(([path, value]) => tarEntry(path, value)),
      Buffer.alloc(1024),
    ]),
  );
}

const SPAWN_SOURCE = 'import { spawn } from "node:child_process";\nspawn("owned-child");\n';
const BUNDLED_HELPER_EXEC_SOURCE = `
import type { ChildProcess } from "node:child_process";
const exec = compileMatcher();
exec(value);
`;

describe("plugin npm artifact security scan", () => {
  it("accepts reviewed production behavior from the exact tarball", () => {
    const result = scanPluginNpmArtifactSecurity({
      packageName: "@openclaw/signal",
      packageVersion: "1.0.0",
      tarball: packageTarball("@openclaw/signal", { "src/daemon.ts": SPAWN_SOURCE }),
    });
    expect(result.criticalFindingCount).toBe(1);
  });

  it("rejects a new critical finding in shipped runtime code", () => {
    expect(() =>
      scanPluginNpmArtifactSecurity({
        packageName: "@openclaw/example",
        packageVersion: "1.0.0",
        tarball: packageTarball("@openclaw/example", { "src/index.ts": SPAWN_SOURCE }),
      }),
    ).toThrow("unreviewed critical findings in exact npm artifact");
  });

  it("rejects fixtures only when npm includes them in the tarball", () => {
    expect(() =>
      scanPluginNpmArtifactSecurity({
        packageName: "@openclaw/example",
        packageVersion: "1.0.0",
        tarball: packageTarball("@openclaw/example", {
          "src/fixtures/example.ts": SPAWN_SOURCE,
        }),
      }),
    ).toThrow("artifact contains test or fixture files");
  });

  it("leaves vendored dependency tests to dependency security evidence", () => {
    const result = scanPluginNpmArtifactSecurity({
      packageName: "@openclaw/example",
      packageVersion: "1.0.0",
      tarball: packageTarball("@openclaw/example", {
        "node_modules/dependency/test/fixture.js": SPAWN_SOURCE,
        "src/index.ts": "export const value = 1;\n",
      }),
    });
    expect(result.scannedFiles).toBe(1);
    expect(result.criticalFindingCount).toBe(0);
  });

  it("scans production code from bundled dependencies", () => {
    expect(() =>
      scanPluginNpmArtifactSecurity({
        packageName: "@openclaw/example",
        packageVersion: "1.0.0",
        tarball: packageTarball("@openclaw/example", {
          "node_modules/dependency/index.js": SPAWN_SOURCE,
        }),
      }),
    ).toThrow("unreviewed critical findings in exact npm artifact");
  });

  it("scans extensionless and directories.bin executables", () => {
    for (const [path, manifest] of [
      ["payload", {}],
      ["tools/generate.txt", { directories: { bin: "tools" } }],
    ] as const) {
      expect(() =>
        scanPluginNpmArtifactSecurity({
          packageName: "@openclaw/example",
          packageVersion: "1.0.0",
          tarball: packageTarball("@openclaw/example", { [path]: SPAWN_SOURCE }, manifest),
        }),
      ).toThrow("unreviewed critical findings in exact npm artifact");
    }
  });

  it("does not carry source allowances into a dist artifact", () => {
    expect(() =>
      scanPluginNpmArtifactSecurity({
        packageName: "@openclaw/signal",
        packageVersion: "1.0.0",
        tarball: packageTarball("@openclaw/signal", {
          "dist/daemon.js": SPAWN_SOURCE,
          "src/index.ts": "export const value = 1;\n",
        }),
      }),
    ).toThrow("unreviewed critical findings in exact npm artifact");
  });

  it("classifies reviewed findings by their file layout", () => {
    const result = scanPluginNpmArtifactSecurity({
      packageName: "@openclaw/acpx",
      packageVersion: "1.0.0",
      tarball: packageTarball("@openclaw/acpx", {
        "dist/.setup/index.mjs": "export const value = 1;\n",
        "dist/mcp-proxy.mjs": SPAWN_SOURCE,
      }),
    });
    expect(result.criticalFindingCount).toBe(1);
  });

  it("keeps the reviewed iMessage setup helper finding exact", () => {
    const result = scanPluginNpmArtifactSecurity({
      packageName: "@openclaw/imessage",
      packageVersion: "1.0.0",
      tarball: packageTarball("@openclaw/imessage", {
        "dist/.setup/sanitize-outbound-3MLljgtY.mjs": BUNDLED_HELPER_EXEC_SOURCE,
      }),
    });
    expect(result.criticalFindingCount).toBe(1);
  });

  it("keeps reviewed dist findings reachable in mixed-layout artifacts", () => {
    const result = scanPluginNpmArtifactSecurity({
      packageName: "@openclaw/google-meet",
      packageVersion: "1.0.0",
      tarball: packageTarball("@openclaw/google-meet", {
        "dist/.setup/chunk.mjs": "export const value = 1;\n",
        "dist/index.js": SPAWN_SOURCE,
      }),
    });
    expect(result.criticalFindingCount).toBe(1);
  });

  it("keeps the reviewed Raft dist finding reachable in a mixed-layout artifact", () => {
    const result = scanPluginNpmArtifactSecurity({
      packageName: "@openclaw/raft",
      packageVersion: "1.0.0",
      tarball: packageTarball("@openclaw/raft", {
        "dist/.setup/chunk.mjs": "export const value = 1;\n",
        "dist/channel-plugin-api.js": SPAWN_SOURCE,
      }),
    });
    expect(result.criticalFindingCount).toBe(1);
  });
});
