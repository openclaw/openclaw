import JSZip from "jszip";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fixtureRoot = path.join(os.tmpdir(), `openclaw-hook-install-${randomUUID()}`);
let tempDirIndex = 0;

let zipHooksBuffer: Buffer;
let zipTraversalBuffer: Buffer;
let tarHooksBuffer: Buffer;
let tarTraversalBuffer: Buffer;
let tarEvilIdBuffer: Buffer;
let tarReservedIdBuffer: Buffer;
let npmPackHooksBuffer: Buffer;

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: vi.fn(),
}));

async function packToArchive({
  pkgDir,
  outDir,
  outName,
}: {
  pkgDir: string;
  outDir: string;
  outName: string;
}) {
  const dest = path.join(outDir, outName);
  fs.rmSync(dest, { force: true });
  await tar.c(
    {
      gzip: true,
      file: dest,
      cwd: path.dirname(pkgDir),
    },
    [path.basename(pkgDir)],
  );
  return dest;
}

function makeTempDir() {
  const dir = path.join(fixtureRoot, `case-${tempDirIndex++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const { runCommandWithTimeout } = await import("../process/exec.js");
const { installHooksFromArchive, installHooksFromNpmSpec, installHooksFromPath } =
  await import("./install.js");

beforeAll(async () => {
  fs.mkdirSync(fixtureRoot, { recursive: true });

  const zipHooks = new JSZip();
  zipHooks.file(
    "package/package.json",
    JSON.stringify({
      name: "@openclaw/zip-hooks",
      version: "0.0.1",
      openclaw: { hooks: ["./hooks/zip-hook"] },
    }),
  );
  zipHooks.file(
    "package/hooks/zip-hook/HOOK.md",
    [
      "---",
      "name: zip-hook",
      "description: Zip hook",
      'metadata: {"openclaw":{"events":["command:new"]}}',
      "---",
      "",
      "# Zip Hook",
    ].join("\n"),
  );
  zipHooks.file("package/hooks/zip-hook/handler.ts", "export default async () => {};\n");
  zipHooksBuffer = await zipHooks.generateAsync({ type: "nodebuffer" });

  const zipTraversal = new JSZip();
  zipTraversal.file("../pwned.txt", "nope\n");
  zipTraversalBuffer = await zipTraversal.generateAsync({ type: "nodebuffer" });

  const makeTarWithPackage = async (params: {
    packageName: string;
    hookName: string;
  }): Promise<Buffer> => {
    const workDir = makeTempDir();
    const archivePath = path.join(workDir, "hooks.tar");
    const pkgDir = path.join(workDir, "package");
    fs.mkdirSync(path.join(pkgDir, "hooks", params.hookName), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: params.packageName,
        version: "0.0.1",
        openclaw: { hooks: [`./hooks/${params.hookName}`] },
      }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pkgDir, "hooks", params.hookName, "HOOK.md"),
      [
        "---",
        `name: ${params.hookName}`,
        `description: ${params.hookName}`,
        'metadata: {"openclaw":{"events":["command:new"]}}',
        "---",
        "",
        "# Hook",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pkgDir, "hooks", params.hookName, "handler.ts"),
      "export default async () => {};\n",
      "utf-8",
    );
    await tar.c({ cwd: workDir, file: archivePath }, ["package"]);
    return await fsPromises.readFile(archivePath);
  };

  tarHooksBuffer = await makeTarWithPackage({
    packageName: "@openclaw/tar-hooks",
    hookName: "tar-hook",
  });
  tarEvilIdBuffer = await makeTarWithPackage({ packageName: "@evil/..", hookName: "evil-hook" });
  tarReservedIdBuffer = await makeTarWithPackage({
    packageName: "@evil/.",
    hookName: "reserved-hook",
  });

  const makeTraversalTar = async (): Promise<Buffer> => {
    const workDir = makeTempDir();
    const insideDir = path.join(workDir, "inside");
    fs.mkdirSync(insideDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, "outside.txt"), "nope\n", "utf-8");
    const archivePath = path.join(workDir, "traversal.tar");
    await tar.c({ cwd: insideDir, file: archivePath }, ["../outside.txt"]);
    return await fsPromises.readFile(archivePath);
  };

  tarTraversalBuffer = await makeTraversalTar();

  const makeNpmPackTgz = async (): Promise<Buffer> => {
    const workDir = makeTempDir();
    const packedName = "test-hooks-0.0.1.tgz";
    const pkgDir = path.join(workDir, "package");
    fs.mkdirSync(path.join(pkgDir, "hooks", "one-hook"), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/test-hooks",
        version: "0.0.1",
        openclaw: { hooks: ["./hooks/one-hook"] },
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

    const packTmpDir = makeTempDir();
    const archivePath = await packToArchive({ pkgDir, outDir: packTmpDir, outName: packedName });
    return await fsPromises.readFile(archivePath);
  };

  npmPackHooksBuffer = await makeNpmPackTgz();
});

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

describe("installHooksFromArchive", () => {
  it("installs hook packs from zip archives", async () => {
    const stateDir = makeTempDir();
    const workDir = makeTempDir();
    const archivePath = path.join(workDir, "hooks.zip");
    fs.writeFileSync(archivePath, zipHooksBuffer);

    const hooksDir = path.join(stateDir, "hooks");
    const result = await installHooksFromArchive({ archivePath, hooksDir });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.hookPackId).toBe("zip-hooks");
    expect(result.hooks).toContain("zip-hook");
    expect(result.targetDir).toBe(path.join(stateDir, "hooks", "zip-hooks"));
    expect(fs.existsSync(path.join(result.targetDir, "hooks", "zip-hook", "HOOK.md"))).toBe(true);
  });

  it("rejects zip archives with traversal entries", async () => {
    const stateDir = makeTempDir();
    const workDir = makeTempDir();
    const archivePath = path.join(workDir, "traversal.zip");
    fs.writeFileSync(archivePath, zipTraversalBuffer);

    const hooksDir = path.join(stateDir, "hooks");
    const result = await installHooksFromArchive({ archivePath, hooksDir });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("failed to extract archive");
    expect(result.error).toContain("archive entry");
  });

  it("installs hook packs from tar archives", async () => {
    const stateDir = makeTempDir();
    const workDir = makeTempDir();
    const archivePath = path.join(workDir, "hooks.tar");
    fs.writeFileSync(archivePath, tarHooksBuffer);

    const hooksDir = path.join(stateDir, "hooks");
    const result = await installHooksFromArchive({ archivePath, hooksDir });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.hookPackId).toBe("tar-hooks");
    expect(result.hooks).toContain("tar-hook");
    expect(result.targetDir).toBe(path.join(stateDir, "hooks", "tar-hooks"));
  });

  it("rejects tar archives with traversal entries", async () => {
    const stateDir = makeTempDir();
    const workDir = makeTempDir();
    const archivePath = path.join(workDir, "traversal.tar");
    fs.writeFileSync(archivePath, tarTraversalBuffer);

    const hooksDir = path.join(stateDir, "hooks");
    const result = await installHooksFromArchive({ archivePath, hooksDir });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("failed to extract archive");
    expect(result.error).toContain("escapes destination");
  });

  it("rejects hook packs with traversal-like ids", async () => {
    const stateDir = makeTempDir();
    const workDir = makeTempDir();
    const archivePath = path.join(workDir, "hooks.tar");
    fs.writeFileSync(archivePath, tarEvilIdBuffer);

    const hooksDir = path.join(stateDir, "hooks");
    const result = await installHooksFromArchive({ archivePath, hooksDir });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("reserved path segment");
  });

  it("rejects hook packs with reserved ids", async () => {
    const stateDir = makeTempDir();
    const workDir = makeTempDir();
    const archivePath = path.join(workDir, "hooks.tar");
    fs.writeFileSync(archivePath, tarReservedIdBuffer);

    const hooksDir = path.join(stateDir, "hooks");
    const result = await installHooksFromArchive({ archivePath, hooksDir });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("reserved path segment");
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
    run.mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    const res = await installHooksFromPath({
      path: pkgDir,
      hooksDir: path.join(stateDir, "hooks"),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }

    const calls = run.mock.calls.filter((c) => Array.isArray(c[0]) && c[0][0] === "npm");
    expect(calls.length).toBe(1);
    const first = calls[0];
    if (!first) {
      throw new Error("expected npm install call");
    }
    const [argv, opts] = first;
    expect(argv).toEqual(["npm", "install", "--omit=dev", "--silent", "--ignore-scripts"]);
    expect(opts?.cwd).toBe(res.targetDir);
  });
});

describe("installHooksFromPath", () => {
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
});

describe("installHooksFromNpmSpec", () => {
  it("uses --ignore-scripts for npm pack and cleans up temp dir", async () => {
    const stateDir = makeTempDir();

    const run = vi.mocked(runCommandWithTimeout);
    let packTmpDir = "";
    const packedName = "test-hooks-0.0.1.tgz";
    run.mockImplementation(async (argv, opts) => {
      if (argv[0] === "npm" && argv[1] === "pack") {
        packTmpDir = String(opts?.cwd ?? "");
        fs.writeFileSync(path.join(packTmpDir, packedName), npmPackHooksBuffer);
        return { code: 0, stdout: `${packedName}\n`, stderr: "", signal: null, killed: false };
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
    expect(fs.existsSync(path.join(result.targetDir, "hooks", "one-hook", "HOOK.md"))).toBe(true);

    const packCalls = run.mock.calls.filter(
      (c) => Array.isArray(c[0]) && c[0][0] === "npm" && c[0][1] === "pack",
    );
    expect(packCalls.length).toBe(1);
    const packCall = packCalls[0];
    if (!packCall) {
      throw new Error("expected npm pack call");
    }
    const [argv, options] = packCall;
    expect(argv).toEqual(["npm", "pack", "@openclaw/test-hooks@0.0.1", "--ignore-scripts"]);
    expect(options?.env).toMatchObject({ NPM_CONFIG_IGNORE_SCRIPTS: "true" });

    expect(packTmpDir).not.toBe("");
    expect(fs.existsSync(packTmpDir)).toBe(false);
  });

  it("rejects non-registry npm specs", async () => {
    const result = await installHooksFromNpmSpec({ spec: "github:evil/evil" });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("unsupported npm spec");
  });
});
