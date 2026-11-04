import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Header } from "tar";
import { afterEach, expect, it } from "vitest";
import { scanWithPublisherTooling } from "../../scripts/check-plugin-npm-security-scan.mts";
import { scanPluginNpmArtifactSecurity } from "../../scripts/plugin-npm-security-scan.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

function tarEntry(path: string, value: string): Buffer {
  const content = Buffer.from(value, "utf8");
  const header = Buffer.alloc(512);
  const entry = new Header({ path, mode: 0o644, size: content.length, mtime: new Date(0) });
  entry.encode(header);
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
  return Buffer.concat([header, content, padding]);
}

function packTarball(
  files: Record<string, string>,
  packageName: string,
  manifest: Record<string, unknown> = {},
) {
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

function scan(
  files: Record<string, string>,
  packageName = "@openclaw/example",
  manifest: Record<string, unknown> = {},
) {
  const tarball = packTarball(files, packageName, manifest);
  return scanPluginNpmArtifactSecurity({ packageName, packageVersion: "1.0.0", tarball });
}

const SPAWN_SOURCE = 'import { spawn } from "node:child_process";\nspawn("owned-child");\n';

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

// Exact worker bytes matching plugin producer 44224876938, job 134536789790.
// Kept as data: the scanner must inspect this child_process call, never execute it.
const CODEX_STDIO_WORKER = readFileSync(
  new URL("../fixtures/plugin-npm-security/codex-stdio.worker.js.txt", import.meta.url),
  "utf8",
);

it("accepts the exact reviewed Codex stdio worker artifact", () => {
  expect(createHash("sha256").update(CODEX_STDIO_WORKER).digest("hex")).toBe(
    "4b974f9a440c7a8ac4356ef11068e0fcea8f363129e59beef46a593a7b12dc48",
  );
  expect(scan({ "dist/stdio.worker.js": CODEX_STDIO_WORKER }, "@openclaw/codex")).toMatchObject({
    scannedFiles: 1,
    criticalFindingCount: 1,
  });
});

it("rejects changed worker bytes and does not transfer the reviewed identity", () => {
  for (const [file, content, packageName] of [
    [
      "dist/stdio.worker.js",
      CODEX_STDIO_WORKER.replace("message.command", '"other-command"'),
      "@openclaw/codex",
    ],
    ["dist/stdio.worker.js", CODEX_STDIO_WORKER + '\nspawn("extra-child");\n', "@openclaw/codex"],
    ["dist/other.worker.js", CODEX_STDIO_WORKER, "@openclaw/codex"],
    ["dist/stdio.worker.js", CODEX_STDIO_WORKER, "@openclaw/example"],
  ] as const) {
    expectUnsafe({ [file]: content }, packageName);
  }
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("rejects publisher-built packs whose reviewed finding bytes drifted", async () => {
  // Stand-in publisher packer; the scan uses the real reviewed inventory.
  const tooling = tempDirs.make("publisher-tooling-");
  mkdirSync(join(tooling, "scripts"));
  const packer = `cp "${tooling}/$(basename "$4").tgz" "$OPENCLAW_PLUGIN_NPM_PACK_OUTPUT_DIR/"`;
  writeFileSync(join(tooling, "scripts/plugin-npm-publish.sh"), packer);
  const name = "@openclaw/openshell-sandbox";
  const files = { "dist/.setup/worker-cli-AbCd1234.mjs": SPAWN_SOURCE };
  writeFileSync(join(tooling, "openshell.tgz"), packTarball(files, name));
  const sha256 = createHash("sha256").update(SPAWN_SOURCE).digest("hex");
  const plan = [name, "@openclaw/brave"].map((packageName) => ({
    packageDir: packageName.includes("openshell") ? "openshell" : "brave",
    packageName,
    version: "1.0.0",
  }));
  // brave has no reviewed finding and no pack, so packing it would fail.
  await expect(scanWithPublisherTooling(tooling, plan)).rejects.toThrow(
    new RegExp(
      `of 1 [\\s\\S]*${name}: unreviewed.*${sha256}.*worker-cli-<hash>[\\s\\S]*new hash`,
      "u",
    ),
  );
});
