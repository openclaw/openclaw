import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listSkillLibrary, readSkillLibrary, saveSkillLibrary } from "./service.js";
import { useSkillLibraryFixture } from "./service.test-support.js";
import type { SkillLibraryAuthority } from "./store.js";

const { fixture } = useSkillLibraryFixture();
const content = "---\nname: guide\ndescription: A reusable test procedure\n---\n# Guide\n";

describe("skill library admission", () => {
  it("publishes subprocess instructions and an environment-token API support file", async () => {
    const { alice, options } = fixture();
    const instructions = `${content}\n\`\`\`js\nimport { execFile } from "node:child_process";\nexecFile("git", ["--version"]);\n\`\`\`\n`;
    const script =
      'const token = process.env.API_TOKEN;\nfetch("https://example.test/api", { headers: { Authorization: `Bearer ${token}` } });\n';
    const saved = await saveSkillLibrary(
      alice,
      {
        slug: "api-guide",
        expectedRevision: null,
        content: instructions,
        files: [{ path: "scripts/api-auth.js", content: script }],
      },
      options,
    );

    expect(saved.state).toBe("published");
    const read = await readSkillLibrary(alice, saved.entry.skillId, undefined, options);
    expect(read.content).toBe(instructions);
    expect(read.files).toEqual([
      {
        path: "scripts/api-auth.js",
        content: Buffer.from(script).toString("base64"),
        encoding: "base64",
        executable: false,
      },
    ]);
  });

  it.each(["instructions", "encoded support file"] as const)(
    "rejects a recognized literal credential in %s before publishing an artifact",
    async (surface) => {
      const { alice, options, stateDir } = fixture();
      const credential = `ghp_${"a".repeat(36)}`;
      await expect(
        saveSkillLibrary(
          alice,
          {
            slug: "credential-guide",
            expectedRevision: null,
            content: surface === "instructions" ? `${content}\n${credential}\n` : content,
            files:
              surface === "encoded support file"
                ? [
                    {
                      path: "references/auth.md",
                      content: Buffer.from(credential).toString("base64"),
                      encoding: "base64",
                    },
                  ]
                : [],
          },
          options,
        ),
      ).rejects.toThrow("contains a recognized literal credential");
      expect((await listSkillLibrary(alice, {}, options)).entries).toEqual([]);
      await expect(fs.access(path.join(stateDir, "skill-library"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("retains fail-closed operator install policy without publishing an artifact", async () => {
    const { alice, options, stateDir } = fixture();
    const authority: SkillLibraryAuthority = {
      ...alice,
      getConfig: () => ({ security: { installPolicy: { enabled: true } } }),
    };
    await expect(
      saveSkillLibrary(authority, { slug: "guide", content, expectedRevision: null }, options),
    ).rejects.toMatchObject({
      code: "POLICY_BLOCKED",
      message: expect.stringContaining("installPolicy.exec is not configured"),
    });
    expect((await listSkillLibrary(alice, {}, options)).entries).toEqual([]);
    const artifacts = await fs.readdir(path.join(stateDir, "skill-library"), {
      recursive: true,
      withFileTypes: true,
    });
    expect(artifacts.filter((entry) => entry.isFile())).toEqual([]);
  });
});
