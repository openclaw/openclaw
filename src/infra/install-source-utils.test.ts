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

const execFileSyncMock = vi.hoisted(() => vi.fn(() => "/tmp/openclaw-test-global-npmrc\n"));
const runCommandWithTimeoutMock = vi.fn();
const tempDirs = createTrackedTempDirs();

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: execFileSyncMock,
  };
});

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

async function createFixtureDir() {
  return await tempDirs.make("openclaw-install-source-utils-");
}

async function createFixtureFile(params: {
  fileName: string;
  contents: string;
  dir?: string;
}): Promise<{ dir: string; filePath: string }> {
  const dir = params.dir ?? (await createFixtureDir());
  const filePath = path.join(dir, params.fileName);
  await fs.writeFile(filePath, params.contents, "utf-8");
  return { dir, filePath };
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

async function runPack(spec: string, cwd: string, timeoutMs = 1000) {
  return await packNpmSpecToArchive({
    spec,
    timeoutMs,
    cwd,
  });
}

async function expectPackFallsBackToDetectedArchive(params: {
  stdout: string;
  expectedMetadata?: Record<string, unknown>;
}) {
  const cwd = await createFixtureDir();
  const archivePath = path.join(cwd, "openclaw-plugin-1.2.3.tgz");
  await fs.writeFile(archivePath, "", "utf-8");
  runCommandWithTimeoutMock.mockResolvedValue({
    stdout: params.stdout,
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
  });

  const result = await packNpmSpecToArchive({
    spec: "openclaw-plugin@1.2.3",
    timeoutMs: 5000,
    cwd,
  });

  expect(result).toEqual({
    ok: true,
    archivePath,
    metadata: params.expectedMetadata ?? {},
  });
}

function expectPackError(result: { ok: boolean; error?: string }, expected: string[]): void {
  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }
  for (const part of expected) {
    expect(result.error ?? "").toContain(part);
  }
}

beforeEach(() => {
  execFileSyncMock.mockClear();
  runCommandWithTimeoutMock.mockClear();
});

afterEach(async () => {
  await tempDirs.cleanup();
});

describe.each([
  {
    owner: "registry metadata",
    prefix: "npm view failed: ",
    category: "metadata-env",
    run: async () => await resolveNpmSpecMetadata({ spec: "example-plugin@1.0.0" }),
  },
  {
    owner: "registry archive packing",
    prefix: "npm pack failed: ",
    category: undefined,
    run: async () => await runPack("example-plugin@1.0.0", await createFixtureDir()),
  },
  {
    owner: "local archive metadata",
    prefix: "npm pack metadata read failed: ",
    category: undefined,
    run: async () => {
      const { filePath } = await createFixtureFile({ fileName: "plugin.tgz", contents: "fixture" });
      return await resolveNpmPackArchiveMetadata({ archivePath: filePath });
    },
  },
])("npm failure diagnostics: $owner", ({ prefix, category, run }) => {
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

describe("resolveArchiveSourcePath", () => {
  it.each([
    {
      name: "returns not found error for missing archive paths",
      path: async () => "/tmp/does-not-exist-openclaw-archive.tgz",
      expected: "archive not found",
    },
    {
      name: "rejects unsupported archive extensions",
      path: async () =>
        (
          await createFixtureFile({
            fileName: "plugin.txt",
            contents: "not-an-archive",
          })
        ).filePath,
      expected: "unsupported archive",
    },
  ])("$name", async ({ path: resolvePath, expected }) => {
    expectPackError(await resolveArchiveSourcePath(await resolvePath()), [expected]);
  });
});

describe("resolveNpmSpecMetadata", () => {
  const npmViewMetadata = {
    name: "@openclaw/codex",
    version: "2026.6.11",
    "dist.integrity": "placeholder",
    "dist.shasum": "placeholder",
    openclaw: {
      extensions: ["./index.ts"],
    },
  };

  it("normalizes npm 12 view JSON", async () => {
    mockPackCommandResult({ stdout: JSON.stringify([npmViewMetadata]) });

    const result = await resolveNpmSpecMetadata({ spec: "@openclaw/codex" });

    expect(result).toEqual({
      ok: true,
      metadata: {
        name: "@openclaw/codex",
        version: "2026.6.11",
        resolvedSpec: "@openclaw/codex@2026.6.11",
        integrity: "placeholder",
        shasum: "placeholder",
        packageOpenClaw: {
          extensions: ["./index.ts"],
        },
      },
    });
  });

  describe("registry selectors", () => {
    const name = "example-plugin";
    it("preserves literal tag v2 in both npm view shapes", async () => {
      const tag = "v2";
      const entry = { name, version: "1.0.0" };
      // npm resolves literal dist-tags before interpreting the selector as a range.
      for (const payload of [entry, [entry]]) {
        mockPackCommandResult({ stdout: JSON.stringify(payload) });
        await expect(resolveNpmSpecMetadata({ spec: `${name}@${tag}` })).resolves.toMatchObject({
          ok: true,
          metadata: { name, version: "1.0.0", resolvedSpec: `${name}@1.0.0` },
        });
      }
    });

    it("selects the max version when v2 is not a literal tag", async () => {
      const tag = "v2";
      mockPackCommandResult({
        stdout: JSON.stringify([
          { name, version: "2.9.0" },
          { name, version: "2.1.0" },
        ]),
      });
      await expect(resolveNpmSpecMetadata({ spec: `${name}@${tag}` })).resolves.toMatchObject({
        ok: true,
        metadata: { name, version: "2.9.0", resolvedSpec: `${name}@2.9.0` },
      });
    });

    it.each(["^2", "2.0.0"])(
      "rejects a singleton outside the non-tag selector %s",
      async (selector) => {
        mockPackCommandResult({ stdout: JSON.stringify([{ name, version: "1.0.0" }]) });
        await expect(
          resolveNpmSpecMetadata({ spec: `${name}@${selector}` }),
        ).resolves.toMatchObject({
          ok: false,
          category: "metadata-env",
        });
      },
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
    const cwd = await createFixtureDir();
    const archivePath = path.join(cwd, "openclaw-plugin-1.2.3.tgz");
    await fs.writeFile(archivePath, "", "utf-8");
    mockPackCommandResult({
      stdout: JSON.stringify([
        {
          id: "openclaw-plugin@1.2.3",
          name: "openclaw-plugin",
          version: "1.2.3",
          filename: "openclaw-plugin-1.2.3.tgz",
          integrity: "sha512-test-integrity",
          shasum: "abc123",
        },
      ]),
    });

    const signal = new AbortController().signal;
    const result = await packNpmSpecToArchive({
      spec: "openclaw-plugin@1.2.3",
      timeoutMs: 1000,
      workTimeoutMs: null,
      cwd,
      signal,
    });

    expect(result).toEqual({
      ok: true,
      archivePath,
      metadata: {
        name: "openclaw-plugin",
        version: "1.2.3",
        resolvedSpec: "openclaw-plugin@1.2.3",
        integrity: "sha512-test-integrity",
        shasum: "abc123",
      },
    });
    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
      expectedNpmCommand([
        "pack",
        "openclaw-plugin@1.2.3",
        "--ignore-scripts",
        "--json",
        "--dry-run=false",
        `--pack-destination=${cwd}`,
      ]),
      {
        cwd,
        timeoutMs: undefined,
        signal,
        killProcessTree: true,
        env: {
          COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
          NPM_CONFIG_IGNORE_SCRIPTS: "true",
          NPM_CONFIG_BEFORE: "",
          NPM_CONFIG_MIN_RELEASE_AGE: "",
          "NPM_CONFIG_MIN-RELEASE-AGE": "",
          npm_config_before: "",
          "npm_config_min-release-age": "",
          npm_config_min_release_age: "0",
        },
      },
    );
  });

  it("uses the workspace archive when npm prints notices without JSON", async () => {
    const cwd = await createFixtureDir();
    const expectedArchivePath = path.join(cwd, "openclaw-plugin-1.2.3.tgz");
    await fs.writeFile(expectedArchivePath, "", "utf-8");
    mockPackCommandResult({
      stdout: "npm notice created package\nopenclaw-plugin-1.2.3.tgz\n",
    });

    const result = await runPack("openclaw-plugin@1.2.3", cwd);

    expect(result).toEqual({
      ok: true,
      archivePath: expectedArchivePath,
      metadata: {},
    });
  });

  it("falls back to cwd archive when logged JSON metadata omits filename", async () => {
    await expectPackFallsBackToDetectedArchive({
      stdout:
        'npm notice using cache\n[{"id":"openclaw-plugin@1.2.3","name":"openclaw-plugin","version":"1.2.3","integrity":"sha512-test-integrity","shasum":"abc123"}]\n',
      expectedMetadata: {
        name: "openclaw-plugin",
        version: "1.2.3",
        resolvedSpec: "openclaw-plugin@1.2.3",
        integrity: "sha512-test-integrity",
        shasum: "abc123",
      },
    });
  });

  it("returns friendly error for 404 (package not on npm)", async () => {
    const cwd = await createFixtureDir();
    mockPackCommandResult({
      stdout: "",
      stderr: "npm error code E404\nnpm error 404  '@openclaw/whatsapp@*' is not in this registry.",
      code: 1,
    });

    const result = await runPack("@openclaw/whatsapp", cwd);
    expectPackError(result, [
      "Package not found on npm",
      "@openclaw/whatsapp",
      "docs.openclaw.ai/tools/plugin",
    ]);
  });

  it("returns explicit error when npm pack produces no archive name", async () => {
    const cwd = await createFixtureDir();
    mockPackCommandResult({
      stdout: " \n\n",
    });

    const result = await runPack("openclaw-plugin@1.2.3", cwd, 5000);

    expect(result).toEqual({
      ok: false,
      error: "npm pack produced no archive",
    });
  });

  it("parses scoped metadata from id-only json output even with npm notice prefix", async () => {
    const cwd = await createFixtureDir();
    await fs.writeFile(path.join(cwd, "openclaw-plugin-demo-2.0.0.tgz"), "", "utf-8");
    mockPackCommandResult({
      stdout:
        "npm notice creating package\n" +
        JSON.stringify([
          {
            id: "@openclaw/plugin-demo@2.0.0",
            filename: "openclaw-plugin-demo-2.0.0.tgz",
          },
        ]),
    });

    const result = await runPack("@openclaw/plugin-demo@2.0.0", cwd);
    expect(result).toEqual({
      ok: true,
      archivePath: path.join(cwd, "openclaw-plugin-demo-2.0.0.tgz"),
      metadata: {
        resolvedSpec: "@openclaw/plugin-demo@2.0.0",
      },
    });
  });
});

describe("resolveNpmPackArchiveMetadata", () => {
  it("reads archive metadata from npm 12 pack output", async () => {
    const cwd = await createFixtureDir();
    const archivePath = path.join(cwd, "openclaw-plugin-1.2.3.tgz");
    await fs.writeFile(archivePath, "tar-bytes", "utf-8");
    const entry = {
      id: "openclaw-plugin@1.2.3",
      name: "openclaw-plugin",
      version: "1.2.3",
      filename: "openclaw-plugin-1.2.3.tgz",
      integrity: "sha512-test-integrity",
      shasum: "abc123",
    };
    mockPackCommandResult({
      stdout: JSON.stringify({ "openclaw-plugin": entry }),
    });

    const result = await resolveNpmPackArchiveMetadata({ archivePath, timeoutMs: 1000 });

    expect(result).toEqual({
      ok: true,
      archivePath,
      tarballName: "openclaw-plugin-1.2.3.tgz",
      metadata: {
        name: "openclaw-plugin",
        version: "1.2.3",
        resolvedSpec: "openclaw-plugin@1.2.3",
        integrity: "sha512-test-integrity",
        shasum: "abc123",
      },
    });
  });
});
