import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SKILL_LIBRARY_MAX_FILE_BYTES,
  validateSkillsLibraryImportParams,
} from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
import { parseSkillRepositoryUrl, withSkillRepository } from "./repository.js";

vi.mock("../../infra/net/fetch-guard.js", () => ({ fetchWithSsrFGuard: vi.fn() }));

const commit = "a".repeat(40);
const url = "https://github.com/example/skills/tree/main/skills/example";
const content = "---\nname: example\ndescription: Example skill\n---\n# Example\n";
const release = vi.fn(async () => {});

async function archive(files: Record<string, string | Buffer>, symlink?: string) {
  const zip = new JSZip();
  for (const [name, bytes] of Object.entries(files)) {
    zip.file(`checkout/${name}`, bytes);
  }
  if (symlink) {
    zip.file(`checkout/${symlink}`, "../../outside", { unixPermissions: 0o120777 });
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", platform: "UNIX" });
}

function serve(bytes: Buffer, afterArchive?: () => void) {
  vi.mocked(fetchWithSsrFGuard).mockImplementation(async (options) => {
    options.beforeRequest?.();
    const response = options.url.startsWith("https://api.github.com/")
      ? new Response(commit)
      : new Response(new Uint8Array(bytes));
    if (options.url.startsWith("https://codeload.github.com/")) {
      afterArchive?.();
    }
    return { response, release, finalUrl: options.url };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GitHub personal skill URLs", () => {
  it("keeps the exact skill directory and explicitly encoded slash ref", () => {
    expect(
      parseSkillRepositoryUrl(
        "https://github.com/example/skills/blob/feature%2Fskills/skills/example/SKILL.md",
      ),
    ).toEqual({
      owner: "example",
      repo: "skills",
      ref: "feature/skills",
      skillPath: "skills/example",
    });
    expect(parseSkillRepositoryUrl("https://github.com/example/skills/tree/main/").skillPath).toBe(
      "",
    );
  });

  it.each([
    "http://github.com/example/skills/tree/main/skill",
    "https://github.com.evil.test/example/skills/tree/main/skill",
    "https://user@github.com/example/skills/tree/main/skill",
    "https://github.com:8443/example/skills/tree/main/skill",
    "https://127.0.0.1/example/skills/tree/main/skill",
    "https://github.com/example/skills/tree/main/../skill",
    "https://github.com/example/skills/tree/main/%2e%2e/skill",
    "https://github.com/example/skills/tree/main/%2Ftmp",
    "https://github.com/example/skills/tree/main/skill%5Cescape",
    "https://github.com/example/skills/tree/main/skill?download=1",
    "https://github.com/example/skills/blob/main/skill/README.md",
  ])("rejects unsafe or non-skill URLs: %s", (input) => {
    expect(() => parseSkillRepositoryUrl(input)).toThrow("Use a public");
  });

  it("accepts only the declared closed source union in the protocol", () => {
    expect(
      validateSkillsLibraryImportParams({ slug: "example", source: { kind: "github", url } }),
    ).toBe(true);
    expect(
      validateSkillsLibraryImportParams({
        slug: "example",
        source: { kind: "clawhub", slug: "example" },
      }),
    ).toBe(true);
    expect(
      validateSkillsLibraryImportParams({
        slug: "example",
        source: { kind: "github", url, slug: "extra" },
      }),
    ).toBe(false);
    expect(validateSkillsLibraryImportParams({ slug: "example", source: { kind: "github" } })).toBe(
      false,
    );
  });
});

it("imports a blob URL at a slash-containing ref and cleans artifacts when publication fails", async () => {
  serve(
    await archive({ "skills/example/SKILL.md": content, "skills/example/data.txt": "support" }),
  );
  let extracted = "";
  await expect(
    withSkillRepository(
      "https://github.com/example/skills/blob/feature%2Fskills/skills/example/SKILL.md",
      () => {},
      async (directory) => {
        extracted = directory;
        expect(await fs.readFile(path.join(directory, "data.txt"), "utf8")).toBe("support");
        throw new Error("Publication failed");
      },
    ),
  ).rejects.toThrow("Publication failed");
  expect(fetchWithSsrFGuard).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({
      url: "https://api.github.com/repos/example/skills/commits/feature%2Fskills",
    }),
  );
  await expect(fs.access(extracted)).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects links, traversal, missing instructions, and oversized support files before publication", async () => {
  const publish = vi.fn(async () => {});
  const sources = [
    await archive({ "skills/example/SKILL.md": content }, "skills/example/link"),
    await archive({ "skills/example/SKILL.md": content, "../escape": "bad" }),
    await archive({ "skills/other/SKILL.md": content }),
    await archive({
      "skills/example/SKILL.md": content,
      "skills/example/large.bin": Buffer.alloc(SKILL_LIBRARY_MAX_FILE_BYTES + 1),
    }),
  ];
  for (const bytes of sources) {
    serve(bytes);
    await expect(withSkillRepository(url, () => {}, publish)).rejects.toMatchObject({
      code: "INVALID_BUNDLE",
    });
  }
  expect(publish).not.toHaveBeenCalled();
});

it("does not publish after authority expires during the download", async () => {
  let expired = false;
  const publish = vi.fn(async () => {});
  serve(await archive({ "skills/example/SKILL.md": content }), () => {
    expired = true;
  });
  await expect(
    withSkillRepository(
      url,
      () => {
        if (expired) {
          throw new Error("Authority expired");
        }
      },
      publish,
    ),
  ).rejects.toThrow("Authority expired");
  expect(publish).not.toHaveBeenCalled();
});

it("releases failed GitHub responses and explains public/ref and rate-limit failures", async () => {
  for (const status of [404, 429]) {
    vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
      response: new Response(null, { status }),
      release,
      finalUrl: url,
    });
    await expect(
      withSkillRepository(
        url,
        () => {},
        async () => {},
      ),
    ).rejects.toThrow(status === 404 ? "only public repositories" : "rate limit");
  }
  expect(release).toHaveBeenCalledTimes(2);
});

it("bounds GitHub archive response bodies and releases both guarded responses", async () => {
  let chunks = 0;
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        if (chunks++ < 33) {
          controller.enqueue(new Uint8Array(1024 * 1024));
        } else {
          controller.close();
        }
      },
    }),
  );
  vi.mocked(fetchWithSsrFGuard)
    .mockResolvedValueOnce({
      response: new Response("a".repeat(40)),
      release,
      finalUrl: "https://api.github.com/",
    })
    .mockResolvedValueOnce({ response, release, finalUrl: "https://codeload.github.com/" });
  await expect(
    withSkillRepository(
      "https://github.com/example/skills/tree/main/skill",
      () => {},
      async () => {},
    ),
  ).rejects.toThrow("limit 33554432 bytes");
  expect(release).toHaveBeenCalledTimes(2);
});
