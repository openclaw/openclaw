import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  SKILL_LIBRARY_MAX_FILE_BYTES,
  validateSkillsLibraryImportParams,
} from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { OpenClawSchema } from "../../config/zod-schema.js";
import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
import { importSkillLibrary } from "../../skills/library/import.js";
import { content, useSkillLibraryFixture } from "../../skills/library/service.test-support.js";
import { resolveSkillLibraryUrl } from "../../skills/library/source-url.js";

// Gateway methods run in forks; shared-state admission must originate on the host main thread.
// mock-isolation: HTTP transport only; extraction, scanning, policy, profile ownership and SQLite publication are real.
vi.mock("../../infra/net/fetch-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/net/fetch-guard.js")>();
  return { ...actual, fetchWithSsrFGuard: vi.fn() };
});
const { fixture } = useSkillLibraryFixture();
function download(response: Response) {
  const release = vi.fn(async () => {});
  vi.mocked(fetchWithSsrFGuard).mockImplementation(async (options) => {
    options.beforeRequest?.();
    return { response, finalUrl: options.url, release };
  });
  return release;
}
async function archive() {
  const { default: JSZip } = await import("jszip");
  return new JSZip()
    .file("repo-main/skills/guide/SKILL.md", content)
    .file("repo-main/skills/guide/notes.md", "Companion notes")
    .file("repo-main/skills/guide/nested/data.bin", Buffer.from([0, 255, 128]))
    .generateAsync({ type: "nodebuffer" });
}
it.each([
  ["/team/repo/tree/main/skills/guide", "/team/repo/archive/main.zip"],
  ["/group/team/repo/-/tree/main/skills/guide", "/group/team/repo/-/archive/main/repo-main.zip"],
  ["/team/repo/src/branch/main/skills/guide", "/team/repo/archive/main.zip"],
])("normalizes a forge folder shape on an arbitrary HTTPS host: %s", (pathname, expected) => {
  const resolved = resolveSkillLibraryUrl({ url: "https://forge.example.test" + pathname });
  expect(resolved).toMatchObject({
    url: "https://forge.example.test" + expected,
    path: "skills/guide",
    file: false,
  });
});
it("uses an explicit slash-containing ref without remote probing", () => {
  expect(
    resolveSkillLibraryUrl({
      url: "https://forge.example.test/team/repo/tree/feature/docs/skills/guide",
      ref: "feature/docs",
    }),
  ).toMatchObject({
    url: "https://forge.example.test/team/repo/archive/feature%2Fdocs.zip",
    path: "skills/guide",
  });
});
it("imports a selected folder with all companion bytes into the personal library", async () => {
  const { alice, options, lib } = fixture();
  const release = download(new Response(await archive()));
  const receipt = await importSkillLibrary(
    alice,
    {
      slug: "imported",
      source: { kind: "url", url: "https://forge.example.test/team/repo/tree/main/skills/guide" },
    },
    options,
  );
  expect(receipt.entry.ownerProfileId).toBe(alice.profileId);
  const read = await lib.read(receipt.entry.skillId);
  expect(read.content).toBe(content);
  expect(read.files).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: "notes.md",
        content: "Companion notes",
        encoding: "utf8",
      }),
      expect.objectContaining({ path: "nested/data.bin", content: "AP+A", encoding: "base64" }),
    ]),
  );
  expect(release).toHaveBeenCalledOnce();
});
it.each(["SKILL.md", "download"])(
  "imports a generic raw skill through the existing save owner: %s",
  async (filename) => {
    const { alice, options, lib } = fixture();
    download(new Response(content, { headers: { "content-type": "text/plain" } }));
    const result = await importSkillLibrary(
      alice,
      { slug: "raw", source: { kind: "url", url: "https://files.example.test/" + filename } },
      options,
    );
    expect((await lib.read(result.entry.skillId)).content).toBe(content);
  },
);
it.each(["missing", "../outside", "skills"])(
  "does not publish an invalid archive directory: %s",
  async (selected) => {
    const { alice, options, lib } = fixture();
    download(new Response(await archive()));
    await expect(
      importSkillLibrary(
        alice,
        {
          slug: "invalid",
          source: { kind: "url", url: "https://files.example.test/bundle.zip", path: selected },
        },
        options,
      ),
    ).rejects.toMatchObject({ code: "INVALID_BUNDLE" });
    expect((await lib.list()).entries).toEqual([]);
  },
);
it("rejects an oversized download with smaller-bundle guidance and no publication", async () => {
  const { alice, options, lib } = fixture();
  download(new Response(new Uint8Array(SKILL_LIBRARY_MAX_FILE_BYTES + 1)));
  await expect(
    importSkillLibrary(
      alice,
      { slug: "large", source: { kind: "url", url: "https://files.example.test/SKILL.md" } },
      options,
    ),
  ).rejects.toMatchObject({
    code: "INVALID_BUNDLE",
    message: expect.stringContaining("smaller skill bundle"),
  });
  expect((await lib.list()).entries).toEqual([]);
});
it.each([503, "html"] as const)(
  "does not publish a failed download or webpage: %s",
  async (failure) => {
    const { alice, options, lib } = fixture();
    const release = download(
      failure === "html"
        ? new Response("<!doctype html><html>Not a skill</html>", {
            headers: { "content-type": "text/html" },
          })
        : new Response("Unavailable", { status: failure }),
    );
    await expect(
      importSkillLibrary(
        alice,
        { slug: "invalid", source: { kind: "url", url: "https://files.example.test/SKILL.md" } },
        options,
      ),
    ).rejects.toMatchObject({ code: "INVALID_BUNDLE" });
    expect((await lib.list()).entries).toEqual([]);
    expect(release).toHaveBeenCalledOnce();
  },
);
it.each(["file", "archive"] as const)(
  "preserves remote %s source facts for the real operator policy",
  async (kind) => {
    const { alice, options, lib, stateDir } = fixture();
    const script = path.join(stateDir, "policy.cjs");
    await fs.writeFile(
      script,
      [
        "#!" + process.execPath,
        "let input = '';",
        "process.stdin.on('data', (data) => input += data);",
        "process.stdin.on('end', () => {",
        "  const request = JSON.parse(input);",
        "  const remote = request.source.kind === " +
          JSON.stringify(kind) +
          " && request.source.authority === 'third-party' && request.source.network === true;",
        "  process.stdout.write(JSON.stringify({ protocolVersion: 1, decision: remote ? 'block' : 'allow', reason: 'remote source denied' }));",
        "});",
      ].join("\n"),
      { mode: 0o700 },
    );
    const authority = {
      ...alice,
      getConfig: () => ({
        skills: { library: { import: { allowedOrigins: ["https://files.example.test"] } } },
        security: {
          installPolicy: {
            enabled: true,
            exec: {
              source: "exec" as const,
              command: script,
              trustedDirs: [stateDir],
              timeoutMs: 5000,
            },
          },
        },
      }),
    };
    download(new Response(kind === "file" ? content : await archive()));
    await expect(
      importSkillLibrary(
        authority,
        {
          slug: "denied",
          source: {
            kind: "url",
            url: "https://files.example.test/" + (kind === "file" ? "SKILL.md" : "bundle.zip"),
            path: kind === "archive" ? "skills/guide" : undefined,
          },
        },
        options,
      ),
    ).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
    expect((await lib.list()).entries).toEqual([]);
  },
);

it("validates only exact HTTPS operator grant origins and retains the strict default", () => {
  expect(OpenClawSchema.parse({}).skills?.library?.import?.allowedOrigins).toBeUndefined();
  const config = (origin: string) => ({
    skills: { library: { import: { allowedOrigins: [origin] } } },
  });
  expect(OpenClawSchema.safeParse(config("https://forge.corp.example:8443/")).success).toBe(true);
  for (const origin of [
    "http://forge.corp.example",
    "https://*.corp.example",
    "https://forge.corp.example/path",
    "https://forge.corp.example?token=x",
    "https://user:password@forge.corp.example",
  ]) {
    expect(OpenClawSchema.safeParse(config(origin)).success).toBe(false);
  }
  expect(
    validateSkillsLibraryImportParams({
      slug: "guide",
      source: {
        kind: "url",
        url: "https://forge.corp.example/SKILL.md",
        allowedOrigins: ["https://forge.corp.example"],
      },
    }),
  ).toBe(false);
});
it("uses only operator origin grants and revalidates them before a network effect", async () => {
  const { alice, options, lib } = fixture();
  const origin = "https://forge.corp.example:8443";
  let origins = [origin];
  const authority = {
    ...alice,
    getConfig: () => ({ skills: { library: { import: { allowedOrigins: origins } } } }),
  };
  download(new Response(content));
  await importSkillLibrary(
    authority,
    { slug: "private", source: { kind: "url", url: origin + "/SKILL.md" } },
    options,
  );
  expect(vi.mocked(fetchWithSsrFGuard).mock.calls.at(-1)?.[0]).toMatchObject({
    mode: "strict",
    policy: { allowedOrigins: [origin] },
  });
  vi.mocked(fetchWithSsrFGuard).mockImplementationOnce(async (request) => {
    origins = [];
    request.beforeRequest?.();
    throw new Error("A revoked grant must not reach the network effect");
  });
  await expect(
    importSkillLibrary(
      authority,
      { slug: "revoked", source: { kind: "url", url: origin + "/SKILL.md" } },
      options,
    ),
  ).rejects.toMatchObject({
    code: "POLICY_BLOCKED",
    message: expect.stringContaining("network policy changed"),
  });
  expect((await lib.list()).entries).toHaveLength(1);
});

it("revalidates source write admission before sending an approved private request", async () => {
  const { alice, options, lib } = fixture();
  const origin = "https://forge.corp.example:8443";
  let writeAllowed = true;
  let sent = false;
  const authority = {
    ...alice,
    getConfig: () => ({ skills: { library: { import: { allowedOrigins: [origin] } } } }),
    assertFileMutationAllowed: () => {
      if (!writeAllowed) {
        throw new Error("write admission revoked");
      }
    },
  };
  vi.mocked(fetchWithSsrFGuard).mockImplementationOnce(async (request) => {
    writeAllowed = false;
    request.beforeRequest?.();
    sent = true;
    return { response: new Response(content), finalUrl: request.url, release: async () => {} };
  });
  await expect(
    importSkillLibrary(
      authority,
      { slug: "revoked-write", source: { kind: "url", url: origin + "/SKILL.md" } },
      options,
    ),
  ).rejects.toThrow("write admission revoked");
  expect(sent).toBe(false);
  expect((await lib.list()).entries).toEqual([]);
});
