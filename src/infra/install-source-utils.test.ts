import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectedNpmCommand } from "../test-utils/npm-command.js";
import { npmCommandFailureCases } from "../test-utils/npm-spec-install-test-helpers.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  packNpmSpecToArchive,
  resolveArchiveSourcePath,
  resolveNpmPackArchiveMetadata,
  resolveNpmSpecMetadata,
} from "./install-source-utils.js";

const runCommandWithTimeoutMock = vi.fn();
const tempDirs = createTrackedTempDirs();
let cwd: string;

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: () => "/tmp/openclaw-test-global-npmrc\n" };
});

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

const packFields = {
  name: "openclaw-plugin",
  version: "1.2.3",
  integrity: "sha512-test-integrity",
  shasum: "abc123",
};
const packMetadata = { ...packFields, resolvedSpec: "openclaw-plugin@1.2.3" };
const packEntry = {
  ...packFields,
  id: packMetadata.resolvedSpec,
  filename: "openclaw-plugin-1.2.3.tgz",
};
const createArchive = (contents = "") => createFixtureFile(packEntry.filename, contents);

async function createFixtureFile(fileName: string, contents = "") {
  const filePath = path.join(cwd, fileName);
  await fs.writeFile(filePath, contents, "utf-8");
  return filePath;
}

function mockPackCommandResult(params: { stdout: string; stderr?: string; code?: number }) {
  runCommandWithTimeoutMock.mockResolvedValue({
    stdout: params.stdout,
    stderr: params.stderr ?? "",
    code: params.code ?? 0,
    signal: null,
    killed: false,
  });
}

async function runPack(spec = packMetadata.resolvedSpec) {
  return await packNpmSpecToArchive({ spec, timeoutMs: 1000, cwd });
}

function expectPackError(result: { ok: boolean; error?: string }, expected: string[]): void {
  expect(result).toMatchObject({ ok: false });
  for (const part of expected) {
    expect(result.error).toContain(part);
  }
}

beforeEach(async () => {
  runCommandWithTimeoutMock.mockClear();
  cwd = await tempDirs.make("openclaw-install-source-utils-");
});

afterEach(async () => {
  await tempDirs.cleanup();
});

describe.each([
  ["npm view failed: ", "metadata-env", () => resolveNpmSpecMetadata({ spec: "example-plugin" })],
  ["npm pack failed: ", undefined, () => runPack("example-plugin")],
  [
    "npm pack metadata read failed: ",
    undefined,
    async () => resolveNpmPackArchiveMetadata({ archivePath: await createArchive() }),
  ],
] as const)("npm failure diagnostics: %s", (prefix, category, run) => {
  const failureCases =
    category === "metadata-env"
      ? npmCommandFailureCases.filter(({ label }) =>
          [
            "exit code without output",
            "cancellation followed by a nonzero exit",
            "no-output-timeout with normalized exit code",
          ].includes(label),
        )
      : npmCommandFailureCases.filter(({ label }) => label === "signal without output");
  it.each(failureCases)("preserves $label", async ({ npmResult, expectedDetail }) => {
    runCommandWithTimeoutMock.mockResolvedValue(npmResult);

    await expect(run()).resolves.toEqual({
      ok: false,
      error: `${prefix}${expectedDetail}`,
      ...(category ? { category } : {}),
    });
  });
});

it.each([
  ["archive not found", async (): Promise<string> => "/tmp/does-not-exist-openclaw-archive.tgz"],
  [
    "unsupported archive",
    async (): Promise<string> => await createFixtureFile("plugin.txt", "not-an-archive"),
  ],
] as const)("resolveArchiveSourcePath rejects %s", async (expected, resolvePath) => {
  expectPackError(await resolveArchiveSourcePath(await resolvePath()), [expected]);
});

describe("resolveNpmSpecMetadata", () => {
  it("normalizes npm 12 view JSON", async () => {
    const openclaw = { extensions: ["./index.ts"] };
    mockPackCommandResult({
      stdout: JSON.stringify([
        {
          name: packFields.name,
          version: packFields.version,
          "dist.integrity": packFields.integrity,
          "dist.shasum": packFields.shasum,
          openclaw,
        },
      ]),
    });

    expect(await resolveNpmSpecMetadata({ spec: packFields.name })).toEqual({
      ok: true,
      metadata: { ...packMetadata, packageOpenClaw: openclaw },
    });
  });

  it.each([
    { selector: "v2", versions: ["1.0.0"], version: "1.0.0" },
    { selector: "v2", versions: ["2.9.0", "2.1.0"], version: "2.9.0" },
    { selector: "^2", versions: ["1.0.0"], version: undefined },
  ])("resolves $selector from $versions", async ({ selector, versions, version }) => {
    const name = "example-plugin";
    const entries = versions.map((entryVersion) => ({ name, version: entryVersion }));
    mockPackCommandResult({ stdout: JSON.stringify(entries) });
    await expect(resolveNpmSpecMetadata({ spec: `${name}@${selector}` })).resolves.toMatchObject(
      version
        ? { ok: true, metadata: { name, version, resolvedSpec: `${name}@${version}` } }
        : { ok: false, category: "metadata-env" },
    );
  });

  it("reports which required metadata fields are missing", async () => {
    mockPackCommandResult({ stdout: JSON.stringify({ version: "2026.6.11" }) });

    await expect(resolveNpmSpecMetadata({ spec: "@openclaw/codex" })).resolves.toEqual({
      ok: false,
      error: "npm view produced incomplete package metadata (missing: name)",
      category: "metadata-env",
    });
  });
});

describe("packNpmSpecToArchive", () => {
  it("packs spec with an unbounded work deadline and retains metadata", async () => {
    const archivePath = await createArchive();
    mockPackCommandResult({ stdout: JSON.stringify([packEntry]) });

    const signal = new AbortController().signal;
    expect(
      await packNpmSpecToArchive({
        spec: "openclaw-plugin@1.2.3",
        timeoutMs: 1000,
        workTimeoutMs: null,
        cwd,
        signal,
      }),
    ).toEqual({ ok: true, archivePath, metadata: packMetadata });
    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
      expectedNpmCommand([
        "pack",
        packMetadata.resolvedSpec,
        "--ignore-scripts",
        "--json",
        "--dry-run=false",
        `--pack-destination=${cwd}`,
      ]),
      expect.objectContaining({
        timeoutMs: undefined,
        signal,
        killProcessTree: true,
        env: expect.objectContaining({
          NPM_CONFIG_IGNORE_SCRIPTS: "true",
          NPM_CONFIG_BEFORE: "",
          NPM_CONFIG_MIN_RELEASE_AGE: "",
          "NPM_CONFIG_MIN-RELEASE-AGE": "",
          npm_config_before: "",
          "npm_config_min-release-age": "",
          npm_config_min_release_age: "0",
        }),
      }),
    );
  });

  it.each([
    { stdout: `npm notice created package\n${packEntry.filename}\n`, metadata: {} },
    {
      stdout: `npm notice using cache\n${JSON.stringify([{ ...packFields, id: packEntry.id }])}\n`,
      metadata: packMetadata,
    },
  ])("falls back to the cwd archive for $stdout", async ({ stdout, metadata }) => {
    const archivePath = await createArchive();
    mockPackCommandResult({ stdout });
    expect(await runPack()).toEqual({
      ok: true,
      archivePath,
      metadata,
    });
  });

  it("returns friendly error for 404 (package not on npm)", async () => {
    mockPackCommandResult({
      stdout: "",
      stderr: "npm error code E404\nnpm error 404  '@openclaw/whatsapp@*' is not in this registry.",
      code: 1,
    });

    expectPackError(await runPack("@openclaw/whatsapp"), [
      "Package not found on npm",
      "@openclaw/whatsapp",
      "docs.openclaw.ai/tools/plugin",
    ]);
  });

  it.each([" \n\n", "[broken"])("rejects npm output without a cwd archive: %s", async (stdout) => {
    mockPackCommandResult({ stdout });
    expect(await runPack()).toEqual({
      ok: false,
      error: "npm pack produced no archive",
    });
  });

  it("parses scoped metadata from id-only json output even with npm notice prefix", async () => {
    const filename = "openclaw-plugin-demo-2.0.0.tgz";
    const archivePath = await createFixtureFile(filename);
    mockPackCommandResult({
      stdout:
        "npm notice creating package\n" +
        JSON.stringify([{ id: "@openclaw/plugin-demo@2.0.0", filename }]),
    });

    expect(await runPack("@openclaw/plugin-demo@2.0.0")).toEqual({
      ok: true,
      archivePath,
      metadata: { resolvedSpec: "@openclaw/plugin-demo@2.0.0" },
    });
  });
});

it("resolveNpmPackArchiveMetadata reads npm 12 pack output", async () => {
  const archivePath = await createArchive("tar-bytes");
  mockPackCommandResult({ stdout: JSON.stringify({ "openclaw-plugin": packEntry }) });
  expect(await resolveNpmPackArchiveMetadata({ archivePath, timeoutMs: 1000 })).toEqual({
    ok: true,
    archivePath,
    tarballName: packEntry.filename,
    metadata: packMetadata,
  });
});
