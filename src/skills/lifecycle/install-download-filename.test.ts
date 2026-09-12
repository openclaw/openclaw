import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import JSZip from "jszip";
import * as tar from "tar";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveSkillToolsRootDir } from "../runtime/tools-dir.js";
import {
  createInstallDownloadTestState,
  withDownloadServer,
} from "../test-support/install-download-test-utils.js";
import { fetchWithSsrFGuardMock } from "../test-support/install-test-mocks.js";
import { createCanonicalFixtureSkill } from "../test-support/test-helpers.js";
import type { SkillEntry } from "../types.js";
import { installDownloadSpec } from "./install-download.js";

vi.mock("../../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
}));

let workspaceDir = "";
let state: OpenClawTestState;
beforeAll(async () => {
  state = await createInstallDownloadTestState();
  workspaceDir = state.workspaceDir;
});
afterAll(async () => {
  await state.cleanup();
});
beforeEach(() => {
  fetchWithSsrFGuardMock.mockReset();
});

function buildEntry(name: string): SkillEntry {
  const baseDir = path.join(workspaceDir, "skills", name);
  return {
    skill: createCanonicalFixtureSkill({
      name,
      description: "Archive filename fixture",
      filePath: path.join(baseDir, "SKILL.md"),
      baseDir,
      source: "openclaw-workspace",
    }),
    frontmatter: {},
  };
}
function mockArchiveResponse(buffer: Uint8Array): void {
  fetchWithSsrFGuardMock.mockResolvedValue({
    response: {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      body: Readable.from([Buffer.from(buffer)]),
    },
    release: async () => undefined,
  });
}

describe("skill download archive filenames", () => {
  it("does not guess an archive type from a URL without an extension or Content-Disposition filename", async () => {
    mockArchiveResponse(Buffer.from("plain-bytes"));
    const result = await installDownloadSpec({
      entry: buildEntry("cd-missing-archive-name"),
      spec: {
        kind: "download",
        id: "dl",
        url: "https://example.invalid/download",
        extract: true,
        targetDir: "runtime",
      },
      timeoutMs: 30_000,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toBe("extract requested but archive type could not be detected");
  });

  it.each([
    {
      name: "quoted filename",
      disposition: 'attachment; filename="runtime.zip"',
      urlPath: "/download",
    },
    {
      name: "RFC 5987 filename* with a language tag",
      disposition: "attachment; filename*=UTF-8'en'runtime.zip",
      urlPath: "/download",
    },
    {
      name: "quoted filename containing a semicolon",
      disposition: 'attachment; filename="runtime;linux.zip"',
      urlPath: "/download",
    },
    {
      name: "UTF-8 filename with an uppercase suffix",
      disposition: "attachment; filename*=UTF-8'en-US'r%C3%A9sum%C3%A9.ZIP",
      urlPath: "/download",
    },
    {
      name: "language tag x-private",
      disposition: "attachment; filename*=UTF-8'x-private'runtime.zip",
      urlPath: "/download",
    },
    {
      name: "language tag i-klingon",
      disposition: "attachment; filename*=UTF-8'i-klingon'runtime.zip",
      urlPath: "/download",
    },
    {
      name: "language tag en-GB-oed",
      disposition: "attachment; filename*=UTF-8'en-GB-oed'runtime.zip",
      urlPath: "/download",
    },
    {
      name: "language tag zh-cmn-Hans-CN",
      disposition: "attachment; filename*=UTF-8'zh-cmn-Hans-CN'runtime.zip",
      urlPath: "/download",
    },
    {
      name: "language tag en-US-u-ca-gregory-x-proof",
      disposition: "attachment; filename*=UTF-8'en-US-u-ca-gregory-x-proof'runtime.zip",
      urlPath: "/download",
    },
    {
      name: "extended filename precedence",
      disposition: "attachment; filename=wrong.tar.gz; filename*=UTF-8''runtime.zip",
      urlPath: "/download",
    },
    {
      name: "ordinary filename after invalid UTF-8",
      disposition: "attachment; filename*=UTF-8''%C3%28.tar.gz; filename=runtime.zip",
      urlPath: "/download",
    },
    {
      name: "URL suffix after an empty extended filename",
      disposition: "attachment; filename=wrong.tar.gz; filename*=UTF-8''",
      urlPath: "/runtime.zip",
    },
    {
      name: "empty extended filename before an ordinary filename",
      disposition: "attachment; filename*=UTF-8''; filename=wrong.tar.gz",
      urlPath: "/runtime.zip",
    },
    {
      name: "URL suffix when Content-Disposition is a generic download name",
      disposition: 'attachment; filename="download"',
      urlPath: "/runtime.zip",
    },
  ])("extracts a zip using Content-Disposition $name", async ({ disposition, name, urlPath }) => {
    const executableContents = "#!/bin/sh\nprintf verified\\n\n";
    const zip = new JSZip();
    zip.folder("package/empty/");
    zip.file("package/run.sh", executableContents, { unixPermissions: 0o755 });
    const archive = await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" });

    await withDownloadServer(
      (response) => {
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-disposition": disposition,
        });
        response.end(archive);
      },
      async (origin) => {
        const entry = buildEntry(`cd-archive-${name.replaceAll(" ", "-")}`);
        const result = await installDownloadSpec({
          entry,
          spec: {
            kind: "download",
            id: "dl",
            url: `${origin}${urlPath}`,
            extract: true,
            targetDir: "runtime",
            stripComponents: 1,
          },
          timeoutMs: 30_000,
        });

        expect(result.message).not.toContain("archive type could not be detected");
        expect(result.ok).toBe(true);
        const destinationDir = path.join(resolveSkillToolsRootDir(entry), "runtime");
        await expect(fs.readFile(path.join(destinationDir, "run.sh"), "utf8")).resolves.toBe(
          executableContents,
        );
      },
    );
  });

  it.each([
    ["generic-name-control", "attachment; filename=download"],
    ["unfinished-quote", 'attachment; filename="wrong.zip'],
    ["quoted-junk", 'attachment; filename="wrong".zip'],
    ["invalid-token", "attachment; filename=wrong name.zip"],
    ["duplicate-name", "attachment; filename=wrong.zip; FILENAME=other.tar.gz"],
    ["duplicate-extended", "attachment; filename*=UTF-8''wrong.zip; filename*=UTF-8''other.tar.gz"],
    ["single-quote-token", "attachment; filename='wrong.zip'"],
    ["quoted-extended-value", "attachment; filename*=\"UTF-8''wrong.zip\""],
    ["invalid-extended-character", "attachment; filename*=UTF-8''wrong'quote.zip"],
    ["raw-tab", 'attachment; filename="wrong\t.zip"'],
    ["invalid-language-0", "attachment; filename*=UTF-8'-en'wrong.zip"],
    ["invalid-language-1", "attachment; filename*=UTF-8'en-'wrong.zip"],
    ["invalid-language-2", "attachment; filename*=UTF-8'en--US'wrong.zip"],
    ["invalid-language-3", "attachment; filename*=UTF-8'123'wrong.zip"],
    ["invalid-language-4", "attachment; filename*=UTF-8'--'wrong.zip"],
    ["invalid-language-5", "attachment; filename*=UTF-8'en-abcdefghi'wrong.zip"],
    ["invalid-language-6", "attachment; filename*=UTF-8'en-a'wrong.zip"],
    ["invalid-language-7", "attachment; filename*=UTF-8'en-1901-1901'wrong.zip"],
    ["invalid-language-8", "attachment; filename*=UTF-8'en-a-foo-a-bar'wrong.zip"],
    ["decoded-control", "attachment; filename*=UTF-8''wrong%00.zip"],
  ])("uses the URL archive format when the header is unusable (%s)", async (name, disposition) => {
    const entry = buildEntry("cd-invalid-" + name);
    const fixtureRoot = path.join(workspaceDir, "fixture-" + name);
    await fs.mkdir(fixtureRoot, { recursive: true });
    await fs.writeFile(path.join(fixtureRoot, "payload.txt"), "verified gzip payload");
    const fixtureArchive = path.join(fixtureRoot, "runtime.tar.gz");
    await tar.c({ cwd: fixtureRoot, file: fixtureArchive, gzip: true }, ["payload.txt"]);
    const archive = await fs.readFile(fixtureArchive);
    await withDownloadServer(
      (response) => {
        response.writeHead(200, { "content-disposition": disposition });
        response.end(archive);
      },
      async (origin) => {
        const result = await installDownloadSpec({
          entry,
          spec: {
            kind: "download",
            id: "dl",
            url: origin + "/runtime.tar.gz",
            extract: true,
            targetDir: "runtime",
          },
          timeoutMs: 30_000,
        });
        expect(result).toMatchObject({ ok: true });
        await expect(
          fs.readFile(path.join(resolveSkillToolsRootDir(entry), "runtime", "payload.txt"), "utf8"),
        ).resolves.toBe("verified gzip payload");
      },
    );
  });
});
