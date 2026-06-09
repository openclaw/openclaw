// Install download tests cover downloading skill archives before extraction.
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveSkillToolsRootDir } from "../runtime/tools-dir.js";
import { createInstallDownloadTestState } from "../test-support/install-download-test-utils.js";
import { hasBinaryMock, runCommandWithTimeoutMock } from "../test-support/install-test-mocks.js";
import { createCanonicalFixtureSkill } from "../test-support/test-helpers.js";
import type { SkillEntry, SkillInstallSpec } from "../types.js";
import { installDownloadSpec } from "./install-download.js";

vi.mock("../../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

vi.mock("../loading/config.js", () => ({
  hasBinary: (bin: string) => hasBinaryMock(bin),
}));

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function buildEntry(name: string): SkillEntry {
  const skillDir = path.join(workspaceDir, "skills", name);
  const filePath = path.join(skillDir, "SKILL.md");
  return {
    skill: createCanonicalFixtureSkill({
      name,
      description: `${name} test skill`,
      filePath,
      baseDir: skillDir,
      source: "openclaw-workspace",
    }),
    frontmatter: {},
  };
}

function buildDownloadSpec(params: {
  url: string;
  archive: "tar.gz" | "tar.bz2" | "zip";
  targetDir: string;
  stripComponents?: number;
}): SkillInstallSpec {
  return {
    kind: "download",
    id: "dl",
    url: params.url,
    archive: params.archive,
    extract: true,
    targetDir: params.targetDir,
    ...(typeof params.stripComponents === "number"
      ? { stripComponents: params.stripComponents }
      : {}),
  };
}

async function installDownloadSkill(params: {
  name: string;
  url: string;
  archive: "tar.gz" | "tar.bz2" | "zip";
  targetDir: string;
  stripComponents?: number;
}) {
  return installDownloadSpec({
    entry: buildEntry(params.name),
    spec: buildDownloadSpec(params),
    timeoutMs: 30_000,
  });
}

function mockArchiveResponse(buffer: Uint8Array): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          body: Readable.from([Buffer.from(buffer)]),
        }) as unknown as Response,
    ),
  );
}

function createCancelableBody() {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
    },
    cancel() {
      canceled = true;
    },
  });
  return { stream, wasCanceled: () => canceled };
}

function runCommandResult(params?: Partial<Record<"code" | "stdout" | "stderr", string | number>>) {
  return {
    code: 0,
    stdout: "",
    stderr: "",
    signal: null,
    killed: false,
    ...params,
  };
}

function mockTarExtractionFlow(params: {
  listOutput: string;
  verboseListOutput: string;
  extract: "ok" | "reject";
}) {
  runCommandWithTimeoutMock.mockImplementation(async (...argv: unknown[]) => {
    const cmd = (argv[0] ?? []) as string[];
    if (cmd[0] === "tar" && cmd[1] === "tf") {
      return runCommandResult({ stdout: params.listOutput });
    }
    if (cmd[0] === "tar" && cmd[1] === "tvf") {
      return runCommandResult({ stdout: params.verboseListOutput });
    }
    if (cmd[0] === "tar" && cmd[1] === "xf") {
      if (params.extract === "reject") {
        throw new Error("should not extract");
      }
      return runCommandResult({ stdout: "ok" });
    }
    return runCommandResult();
  });
}

let workspaceDir = "";
let testState: OpenClawTestState | undefined;
const PUBLIC_DOWNLOAD_BASE_URL = "https://93.184.216.34";
beforeAll(async () => {
  testState = await createInstallDownloadTestState();
  workspaceDir = testState.workspaceDir;
});

afterAll(async () => {
  await testState?.cleanup();
  testState = undefined;
  workspaceDir = "";
});

beforeEach(() => {
  runCommandWithTimeoutMock.mockReset();
  runCommandWithTimeoutMock.mockResolvedValue(runCommandResult());
  vi.unstubAllGlobals();
  hasBinaryMock.mockReset();
  hasBinaryMock.mockReturnValue(true);
});

describe("installDownloadSpec extraction safety", () => {
  it("rejects targetDir escapes outside the per-skill tools root", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const entry = buildEntry("relative-traversal");
    const toolsRoot = resolveSkillToolsRootDir(entry);
    const escapedTargetDir = path.resolve(toolsRoot, "../outside");

    const result = await installDownloadSpec({
      entry,
      spec: buildDownloadSpec({
        url: `${PUBLIC_DOWNLOAD_BASE_URL}/good.zip`,
        archive: "zip",
        targetDir: "../outside",
      }),
      timeoutMs: 30_000,
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Refusing to install outside the skill tools directory");
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(fileExists(toolsRoot)).resolves.toBe(true);
    await expect(fileExists(escapedTargetDir)).resolves.toBe(false);
  });

  it("allows relative targetDir inside the per-skill tools root", async () => {
    mockArchiveResponse(new TextEncoder().encode("payload"));
    const entry = buildEntry("relative-targetdir");

    const result = await installDownloadSpec({
      entry,
      spec: {
        kind: "download",
        id: "dl",
        url: `${PUBLIC_DOWNLOAD_BASE_URL}/payload.bin`,
        extract: false,
        targetDir: "runtime",
      },
      timeoutMs: 30_000,
    });
    expect(result.ok).toBe(true);
    expect(
      await fs.readFile(
        path.join(resolveSkillToolsRootDir(entry), "runtime", "payload.bin"),
        "utf-8",
      ),
    ).toBe("payload");
  });

  it("cancels failed download response bodies before returning the error", async () => {
    const { stream, wasCanceled } = createCancelableBody();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 500,
            statusText: "Server Error",
            body: stream,
          }) as Response,
      ),
    );

    const result = await installDownloadSpec({
      entry: buildEntry("failed-download-body"),
      spec: {
        kind: "download",
        id: "dl",
        url: `${PUBLIC_DOWNLOAD_BASE_URL}/broken.bin`,
        extract: false,
        targetDir: "runtime",
      },
      timeoutMs: 30_000,
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Download failed (500 Server Error)");
    expect(wasCanceled()).toBe(true);
  });

  it("rejects local download URLs before fetching in stock direct mode", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await installDownloadSpec({
      entry: buildEntry("local-download"),
      spec: {
        kind: "download",
        id: "dl",
        url: "http://127.0.0.1/payload.bin",
        extract: false,
        targetDir: "runtime",
      },
      timeoutMs: 30_000,
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Blocked");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-HTTP download URLs before fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await installDownloadSpec({
      entry: buildEntry("non-http-download"),
      spec: {
        kind: "download",
        id: "dl",
        url: "data:text/plain,hello",
        extract: false,
        targetDir: "runtime",
      },
      timeoutMs: 30_000,
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Download URL must use http or https");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cleans download timeouts when fetch rejects before a response", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const result = await installDownloadSpec({
      entry: buildEntry("failed-download-fetch"),
      spec: {
        kind: "download",
        id: "dl",
        url: `${PUBLIC_DOWNLOAD_BASE_URL}/broken.bin`,
        extract: false,
        targetDir: "runtime",
      },
      timeoutMs: 30_000,
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("network down");
    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  it.runIf(process.platform !== "win32")(
    "fails closed when the lexical tools root is rebound before the final copy",
    async () => {
      const entry = buildEntry("base-rebind");
      const safeToolsRoot = resolveSkillToolsRootDir(entry);
      const outsideRoot = path.join(workspaceDir, "outside-root");
      await fs.mkdir(outsideRoot, { recursive: true });

      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            ({
              ok: true,
              status: 200,
              statusText: "OK",
              body: Readable.from(
                (async function* () {
                  yield Buffer.from("payload");
                  const reboundRoot = `${safeToolsRoot}-rebound`;
                  await fs.rename(safeToolsRoot, reboundRoot);
                  await fs.symlink(outsideRoot, safeToolsRoot);
                })(),
              ),
            }) as unknown as Response,
        ),
      );

      const result = await installDownloadSpec({
        entry,
        spec: {
          kind: "download",
          id: "dl",
          url: `${PUBLIC_DOWNLOAD_BASE_URL}/payload.bin`,
          extract: false,
          targetDir: "runtime",
        },
        timeoutMs: 30_000,
      });

      expect(result.ok).toBe(false);
      expect(await fileExists(path.join(outsideRoot, "runtime", "payload.bin"))).toBe(false);
    },
  );
});

describe("installDownloadSpec extraction safety (tar.bz2)", () => {
  it("handles tar.bz2 extraction safety edge-cases", async () => {
    for (const testCase of [
      {
        label: "rejects archives containing symlinks",
        name: "tbz2-symlink",
        url: `${PUBLIC_DOWNLOAD_BASE_URL}/evil.tbz2`,
        listOutput: "link\n",
        verboseListOutput: "lrwxr-xr-x  0 0 0 0 Jan  1 00:00 link -> ../outside\n",
        extract: "reject" as const,
        expectedOk: false,
        expectedExtract: false,
        expectedStderrSubstring: "link",
      },
      {
        label: "extracts safe archives with stripComponents",
        name: "tbz2-ok",
        url: `${PUBLIC_DOWNLOAD_BASE_URL}/good.tbz2`,
        listOutput: "package/hello.txt\n",
        verboseListOutput: "-rw-r--r--  0 0 0 0 Jan  1 00:00 package/hello.txt\n",
        stripComponents: 1,
        extract: "ok" as const,
        expectedOk: true,
        expectedExtract: true,
      },
    ]) {
      const entry = buildEntry(testCase.name);
      const targetDir = path.join(resolveSkillToolsRootDir(entry), "target");
      const commandCallCount = runCommandWithTimeoutMock.mock.calls.length;

      mockArchiveResponse(new Uint8Array([1, 2, 3]));
      mockTarExtractionFlow({
        listOutput: testCase.listOutput,
        verboseListOutput: testCase.verboseListOutput,
        extract: testCase.extract,
      });

      const result = await installDownloadSkill({
        name: testCase.name,
        url: testCase.url,
        archive: "tar.bz2",
        stripComponents: testCase.stripComponents,
        targetDir,
      });
      expect(result.ok, testCase.label).toBe(testCase.expectedOk);

      const extractionAttempted = runCommandWithTimeoutMock.mock.calls
        .slice(commandCallCount)
        .some((call) => (call[0] as string[])[1] === "xf");
      expect(extractionAttempted, testCase.label).toBe(testCase.expectedExtract);

      if (typeof testCase.expectedStderrSubstring === "string") {
        expect(result.stderr.toLowerCase(), testCase.label).toContain(
          testCase.expectedStderrSubstring,
        );
      }
    }
  });

  it("rejects tar.bz2 archives that change after preflight", async () => {
    const entry = buildEntry("tbz2-preflight-change");
    const targetDir = path.join(resolveSkillToolsRootDir(entry), "target");
    const commandCallCount = runCommandWithTimeoutMock.mock.calls.length;

    mockArchiveResponse(new Uint8Array([1, 2, 3]));

    runCommandWithTimeoutMock.mockImplementation(async (...argv: unknown[]) => {
      const cmd = (argv[0] ?? []) as string[];
      if (cmd[0] === "tar" && cmd[1] === "tf") {
        return runCommandResult({ stdout: "package/hello.txt\n" });
      }
      if (cmd[0] === "tar" && cmd[1] === "tvf") {
        const archivePath = cmd[2] ?? "";
        if (archivePath) {
          await fs.appendFile(archivePath, "mutated");
        }
        return runCommandResult({ stdout: "-rw-r--r--  0 0 0 0 Jan  1 00:00 package/hello.txt\n" });
      }
      if (cmd[0] === "tar" && cmd[1] === "xf") {
        throw new Error("should not extract");
      }
      return runCommandResult();
    });

    const result = await installDownloadSkill({
      name: "tbz2-preflight-change",
      url: `${PUBLIC_DOWNLOAD_BASE_URL}/change.tbz2`,
      archive: "tar.bz2",
      targetDir,
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("changed during safety preflight");
    const extractionAttempted = runCommandWithTimeoutMock.mock.calls
      .slice(commandCallCount)
      .some((call) => (call[0] as string[])[1] === "xf");
    expect(extractionAttempted).toBe(false);
  });

  it("rejects tar.bz2 entries that traverse pre-existing targetDir symlinks", async () => {
    const entry = buildEntry("tbz2-targetdir-symlink");
    const targetDir = path.join(resolveSkillToolsRootDir(entry), "target");
    const outsideDir = path.join(workspaceDir, "tbz2-targetdir-outside");
    await fs.mkdir(targetDir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.symlink(
      outsideDir,
      path.join(targetDir, "escape"),
      process.platform === "win32" ? "junction" : undefined,
    );

    mockArchiveResponse(new Uint8Array([1, 2, 3]));

    runCommandWithTimeoutMock.mockImplementation(async (...argv: unknown[]) => {
      const cmd = (argv[0] ?? []) as string[];
      if (cmd[0] === "tar" && cmd[1] === "tf") {
        return runCommandResult({ stdout: "escape/pwn.txt\n" });
      }
      if (cmd[0] === "tar" && cmd[1] === "tvf") {
        return runCommandResult({ stdout: "-rw-r--r--  0 0 0 0 Jan  1 00:00 escape/pwn.txt\n" });
      }
      if (cmd[0] === "tar" && cmd[1] === "xf") {
        const stagingDir = cmd[cmd.indexOf("-C") + 1] ?? "";
        await fs.mkdir(path.join(stagingDir, "escape"), { recursive: true });
        await fs.writeFile(path.join(stagingDir, "escape", "pwn.txt"), "owned");
        return runCommandResult({ stdout: "ok" });
      }
      return runCommandResult();
    });

    const result = await installDownloadSkill({
      name: "tbz2-targetdir-symlink",
      url: `${PUBLIC_DOWNLOAD_BASE_URL}/evil.tbz2`,
      archive: "tar.bz2",
      targetDir,
    });

    expect(result.ok).toBe(false);
    expect(result.stderr.toLowerCase()).toContain("archive entry traverses symlink in destination");
    expect(await fileExists(path.join(outsideDir, "pwn.txt"))).toBe(false);
  });
});
