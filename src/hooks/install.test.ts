import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  expectSingleNpmInstallIgnoreScriptsCall,
  expectSingleNpmPackIgnoreScriptsCall,
} from "../test-utils/exec-assertions.js";
import { isAddressInUseError } from "./gmail-watcher.js";

const fixtureRoot = path.join(os.tmpdir(), `openclaw-hook-install-${randomUUID()}`);
let tempDirIndex = 0;

const fixturesDir = path.resolve(process.cwd(), "test", "fixtures", "hooks-install");
const zipHooksBuffer = fs.readFileSync(path.join(fixturesDir, "zip-hooks.zip"));
const zipTraversalBuffer = fs.readFileSync(path.join(fixturesDir, "zip-traversal.zip"));
const tarHooksBuffer = fs.readFileSync(path.join(fixturesDir, "tar-hooks.tar"));
const tarTraversalBuffer = fs.readFileSync(path.join(fixturesDir, "tar-traversal.tar"));
const tarEvilIdBuffer = fs.readFileSync(path.join(fixturesDir, "tar-evil-id.tar"));
const tarReservedIdBuffer = fs.readFileSync(path.join(fixturesDir, "tar-reserved-id.tar"));
const npmPackHooksBuffer = fs.readFileSync(path.join(fixturesDir, "npm-pack-hooks.tgz"));

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: vi.fn(),
}));

function makeTempDir() {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const dir = path.join(fixtureRoot, `case-${tempDirIndex++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const { runCommandWithTimeout } = await import("../process/exec.js");
const { installHooksFromArchive, installHooksFromNpmSpec, installHooksFromPath } =
  await import("./install.js");

afterAll(() => {
  try {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
});

beforeEach(() => {
  vi.clearAllMocks();
});

function writeArchiveFixture(params: { fileName: string; contents: Buffer }) {
  const stateDir = makeTempDir();
  const workDir = makeTempDir();
  const archivePath = path.join(workDir, params.fileName);
  fs.writeFileSync(archivePath, params.contents);
  return {
    stateDir,
    archivePath,
    hooksDir: path.join(stateDir, "hooks"),
  };
}

async function expectUnsupportedNpmSpec(
  install: (spec: string) => Promise<{ ok: boolean; error?: string }>,
) {
  const result = await install("github:evil/evil");
  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }
  expect(result.error).toContain("unsupported npm spec");
}

function expectInstallFailureContains(
  result: Awaited<ReturnType<typeof installHooksFromArchive>>,
  snippets: string[],
) {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected install failure");
  }
  for (const snippet of snippets) {
    expect(result.error).toContain(snippet);
  }
}

describe("installHooksFromArchive", () => {
  it.each([
    {
      name: "zip",
      fileName: "hooks.zip",
      contents: zipHooksBuffer,
      expectedPackId: "zip-hooks",
      expectedHook: "zip-hook",
    },
    {
      name: "tar",
      fileName: "hooks.tar",
      contents: tarHooksBuffer,
      expectedPackId: "tar-hooks",
      expectedHook: "tar-hook",
    },
  ])("installs hook packs from $name archives", async (tc) => {
    const fixture = writeArchiveFixture({ fileName: tc.fileName, contents: tc.contents });
    const result = await installHooksFromArchive({
      archivePath: fixture.archivePath,
      hooksDir: fixture.hooksDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.hookPackId).toBe(tc.expectedPackId);
    expect(result.hooks).toContain(tc.expectedHook);
    expect(result.targetDir).toBe(path.join(fixture.stateDir, "hooks", tc.expectedPackId));
    expect(fs.existsSync(path.join(result.targetDir, "hooks", tc.expectedHook, "HOOK.md"))).toBe(
      true,
    );
  });

  it.each([
    {
      name: "zip",
      fileName: "traversal.zip",
      contents: zipTraversalBuffer,
      expectedDetail: "archive entry",
    },
    {
      name: "tar",
      fileName: "traversal.tar",
      contents: tarTraversalBuffer,
      expectedDetail: "escapes destination",
    },
  ])("rejects $name archives with traversal entries", async (tc) => {
    const fixture = writeArchiveFixture({ fileName: tc.fileName, contents: tc.contents });
    const result = await installHooksFromArchive({
      archivePath: fixture.archivePath,
      hooksDir: fixture.hooksDir,
    });
    expectInstallFailureContains(result, ["failed to extract archive", tc.expectedDetail]);
  });

  it.each([
    {
      name: "traversal-like ids",
      contents: tarEvilIdBuffer,
    },
    {
      name: "reserved ids",
      contents: tarReservedIdBuffer,
    },
  ])("rejects hook packs with $name", async (tc) => {
    const fixture = writeArchiveFixture({ fileName: "hooks.tar", contents: tc.contents });
    const result = await installHooksFromArchive({
      archivePath: fixture.archivePath,
      hooksDir: fixture.hooksDir,
    });
    expectInstallFailureContains(result, ["reserved path segment"]);
  });
});

describe("installHooksFromPath", () => {
  it("uses --ignore-scripts for dependency install", async () => {
    const workDir = makeTempDir();
    const stateDir = makeTempDir();
    const pkgDir = path.join(workDir, "package");
    fs.mkdirSync(path.join(pkgDir, "hooks", "one-hook"), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/test-hooks",
        version: "0.0.1",
        openclaw: { hooks: ["./hooks/one-hook"] },
        dependencies: { "left-pad": "1.3.0" },
      }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pkgDir, "hooks", "one-hook", "HOOK.md"),
      [
        "---",
        "name: one-hook",
        "description: One hook",
        'metadata: {"openclaw":{"events":["command:new"]}}',
        "---",
        "",
        "# One Hook",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pkgDir, "hooks", "one-hook", "handler.ts"),
      "export default async () => {};\n",
      "utf-8",
    );

    const run = vi.mocked(runCommandWithTimeout);
    run.mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
      signal: null,
      killed: false,
      termination: "exit",
    });

    const res = await installHooksFromPath({
      path: pkgDir,
      hooksDir: path.join(stateDir, "hooks"),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expectSingleNpmInstallIgnoreScriptsCall({
      calls: run.mock.calls as Array<[unknown, { cwd?: string } | undefined]>,
      expectedCwd: res.targetDir,
    });
  });

  it("installs a single hook directory", async () => {
    const stateDir = makeTempDir();
    const workDir = makeTempDir();
    const hookDir = path.join(workDir, "my-hook");
    fs.mkdirSync(hookDir, { recursive: true });
    fs.writeFileSync(
      path.join(hookDir, "HOOK.md"),
      [
        "---",
        "name: my-hook",
        "description: My hook",
        'metadata: {"openclaw":{"events":["command:new"]}}',
        "---",
        "",
        "# My Hook",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(path.join(hookDir, "handler.ts"), "export default async () => {};\n");

    const hooksDir = path.join(stateDir, "hooks");
    const result = await installHooksFromPath({ path: hookDir, hooksDir });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.hookPackId).toBe("my-hook");
    expect(result.hooks).toEqual(["my-hook"]);
    expect(result.targetDir).toBe(path.join(stateDir, "hooks", "my-hook"));
    expect(fs.existsSync(path.join(result.targetDir, "HOOK.md"))).toBe(true);
  });

  it("rejects hook pack entries that traverse outside package directory", async () => {
    const stateDir = makeTempDir();
    const workDir = makeTempDir();
    const pkgDir = path.join(workDir, "package");
    const outsideHookDir = path.join(workDir, "outside");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.mkdirSync(outsideHookDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/test-hooks",
        version: "0.0.1",
        openclaw: { hooks: ["../outside"] },
      }),
      "utf-8",
    );
    fs.writeFileSync(path.join(outsideHookDir, "HOOK.md"), "---\nname: outside\n---\n", "utf-8");
    fs.writeFileSync(path.join(outsideHookDir, "handler.ts"), "export default async () => {};\n");

    const result = await installHooksFromPath({
      path: pkgDir,
      hooksDir: path.join(stateDir, "hooks"),
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("openclaw.hooks entry escapes package directory");
  });

  it("rejects hook pack entries that escape via symlink", async () => {
    const stateDir = makeTempDir();
    const workDir = makeTempDir();
    const pkgDir = path.join(workDir, "package");
    const outsideHookDir = path.join(workDir, "outside");
    const linkedDir = path.join(pkgDir, "linked");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.mkdirSync(outsideHookDir, { recursive: true });
    fs.writeFileSync(path.join(outsideHookDir, "HOOK.md"), "---\nname: outside\n---\n", "utf-8");
    fs.writeFileSync(path.join(outsideHookDir, "handler.ts"), "export default async () => {};\n");
    try {
      fs.symlinkSync(outsideHookDir, linkedDir, process.platform === "win32" ? "junction" : "dir");
    } catch {
      return;
    }
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/test-hooks",
        version: "0.0.1",
        openclaw: { hooks: ["./linked"] },
      }),
      "utf-8",
    );

    const result = await installHooksFromPath({
      path: pkgDir,
      hooksDir: path.join(stateDir, "hooks"),
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("openclaw.hooks entry resolves outside package directory");
  });
});

describe("installHooksFromNpmSpec", () => {
  it("uses --ignore-scripts for npm pack and cleans up temp dir", async () => {
    const stateDir = makeTempDir();

    const run = vi.mocked(runCommandWithTimeout);
    let packTmpDir = "";
    const packedName = "test-hooks-0.0.1.tgz";
    run.mockImplementation(async (argv, opts) => {
      if (argv[0] === "npm" && argv[1] === "pack") {
        packTmpDir = String(typeof opts === "number" ? "" : (opts.cwd ?? ""));
        fs.writeFileSync(path.join(packTmpDir, packedName), npmPackHooksBuffer);
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              id: "@openclaw/test-hooks@0.0.1",
              name: "@openclaw/test-hooks",
              version: "0.0.1",
              filename: packedName,
              integrity: "sha512-hook-test",
              shasum: "hookshasum",
            },
          ]),
          stderr: "",
          signal: null,
          killed: false,
          termination: "exit",
        };
      }
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    });

    const hooksDir = path.join(stateDir, "hooks");
    const result = await installHooksFromNpmSpec({
      spec: "@openclaw/test-hooks@0.0.1",
      hooksDir,
      logger: { info: () => {}, warn: () => {} },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.hookPackId).toBe("test-hooks");
    expect(result.npmResolution?.resolvedSpec).toBe("@openclaw/test-hooks@0.0.1");
    expect(result.npmResolution?.integrity).toBe("sha512-hook-test");
    expect(fs.existsSync(path.join(result.targetDir, "hooks", "one-hook", "HOOK.md"))).toBe(true);

    expectSingleNpmPackIgnoreScriptsCall({
      calls: run.mock.calls,
      expectedSpec: "@openclaw/test-hooks@0.0.1",
    });

    expect(packTmpDir).not.toBe("");
    expect(fs.existsSync(packTmpDir)).toBe(false);
  });

  it("rejects non-registry npm specs", async () => {
    await expectUnsupportedNpmSpec((spec) => installHooksFromNpmSpec({ spec }));
  });

  it("aborts when integrity drift callback rejects the fetched artifact", async () => {
    const run = vi.mocked(runCommandWithTimeout);
    run.mockResolvedValue({
      code: 0,
      stdout: JSON.stringify([
        {
          id: "@openclaw/test-hooks@0.0.1",
          name: "@openclaw/test-hooks",
          version: "0.0.1",
          filename: "test-hooks-0.0.1.tgz",
          integrity: "sha512-new",
          shasum: "newshasum",
        },
      ]),
      stderr: "",
      signal: null,
      killed: false,
      termination: "exit",
    });

    const onIntegrityDrift = vi.fn(async () => false);
    const result = await installHooksFromNpmSpec({
      spec: "@openclaw/test-hooks@0.0.1",
      expectedIntegrity: "sha512-old",
      onIntegrityDrift,
    });

    expect(onIntegrityDrift).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedIntegrity: "sha512-old",
        actualIntegrity: "sha512-new",
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("integrity drift");
  });
});

describe("gmail watcher", () => {
  it("detects address already in use errors", () => {
    expect(isAddressInUseError("listen tcp 127.0.0.1:8788: bind: address already in use")).toBe(
      true,
    );
    expect(isAddressInUseError("EADDRINUSE: address already in use")).toBe(true);
    expect(isAddressInUseError("some other error")).toBe(false);
  });
});
