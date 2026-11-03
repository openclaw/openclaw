import { gzipSync } from "node:zlib";
import { Header } from "tar";
import { expect, it } from "vitest";
import { scanPluginNpmArtifactSecurity } from "../../scripts/plugin-npm-security-scan.mts";

function tarEntry(path: string, value: string): Buffer {
  const content = Buffer.from(value, "utf8");
  const header = Buffer.alloc(512);
  const entry = new Header({ path, mode: 0o644, size: content.length, mtime: new Date(0) });
  entry.encode(header);
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
  return Buffer.concat([header, content, padding]);
}

function scan(
  files: Record<string, string>,
  packageName = "@openclaw/example",
  manifest: Record<string, unknown> = {},
) {
  const entries = {
    "package/package.json": JSON.stringify({ name: packageName, version: "1.0.0", ...manifest }),
    "package/openclaw.plugin.json": JSON.stringify({ id: "example" }),
    ...Object.fromEntries(Object.entries(files).map(([path, value]) => [`package/${path}`, value])),
  };
  const tarball = gzipSync(
    Buffer.concat([
      ...Object.entries(entries).map(([path, value]) => tarEntry(path, value)),
      Buffer.alloc(1024),
    ]),
  );
  return scanPluginNpmArtifactSecurity({ packageName, packageVersion: "1.0.0", tarball });
}

const SPAWN_SOURCE = 'import { spawn } from "node:child_process";\nspawn("owned-child");\n';
const BUNDLED_HELPER_EXEC_SOURCE = `
import type { ChildProcess } from "node:child_process";
const exec = compileMatcher();
exec(value);
`;

function expectUnsafe(
  files: Record<string, string>,
  packageName?: string,
  manifest?: Record<string, unknown>,
) {
  expect(() => scan(files, packageName, manifest)).toThrow(
    "unreviewed critical findings in exact npm artifact",
  );
}

it("rejects fixtures only when npm includes them in the tarball", () => {
  expect(() => scan({ "src/fixtures/example.ts": SPAWN_SOURCE })).toThrow(
    "artifact contains test or fixture files",
  );
});

it("leaves vendored dependency tests to dependency security evidence", () => {
  const result = scan({
    "node_modules/dependency/test/fixture.js": SPAWN_SOURCE,
    "src/index.ts": "export const value = 1;\n",
  });
  expect(result).toMatchObject({ scannedFiles: 1, criticalFindingCount: 0 });
});

it("scans production code from bundled dependencies", () => {
  expectUnsafe({ "node_modules/dependency/index.js": SPAWN_SOURCE });
});

it("scans extensionless and directories.bin executables", () => {
  for (const [path, manifest] of [
    ["payload", {}],
    ["tools/generate.txt", { directories: { bin: "tools" } }],
  ] as const) {
    expectUnsafe({ [path]: SPAWN_SOURCE }, "@openclaw/example", manifest);
  }
});

it("does not carry source allowances into a dist artifact", () => {
  expectUnsafe(
    { "dist/daemon.js": SPAWN_SOURCE, "src/index.ts": "export const value = 1;\n" },
    "@openclaw/signal",
  );
});

it("classifies reviewed findings by their file layout", () => {
  const result = scan(
    {
      "dist/.setup/index.mjs": "export const value = 1;\n",
      "dist/mcp-proxy.mjs": SPAWN_SOURCE,
    },
    "@openclaw/acpx",
  );
  expect(result.criticalFindingCount).toBe(1);
});

it("rejects changed bytes at the reviewed iMessage setup helper path", () => {
  expectUnsafe(
    { "dist/.setup/sanitize-outbound-3MLljgtY.mjs": BUNDLED_HELPER_EXEC_SOURCE },
    "@openclaw/imessage",
  );
});
