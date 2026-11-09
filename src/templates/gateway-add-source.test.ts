import { createHash } from "node:crypto";
import { symlink, link, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import * as tar from "tar";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withResolvedTemplateAddSource } from "./gateway-add-source.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it("snapshots and retains only canonical local project content without claiming registry trust", async () => {
  const project = dirs.make("local-project-");
  const stateDir = dirs.make("local-state-");
  await writeFile(
    join(project, "package.json"),
    JSON.stringify({
      name: "@fixture/local-template",
      version: "1.0.0",
      openclaw: { template: "CLAW.md" },
    }),
  );
  const manifest =
    "---\nschemaVersion: 1\nagent: { id: local-template }\n---\nLocal instructions.\n";
  await writeFile(join(project, "CLAW.md"), manifest);
  await writeFile(join(project, "private.txt"), "not selected");
  const result = await withResolvedTemplateAddSource({
    coordinate: { kind: "local", path: project },
    mode: "apply",
    stateDir,
    run: async (source, trust, persist) => {
      expect(trust).toMatchObject({
        riskAcknowledgementRequired: false,
        trustWarning: expect.stringContaining("not published to or scanned"),
      });
      expect(trust).not.toHaveProperty("trustRecord");
      await writeFile(join(project, "CLAW.md"), manifest + "Changed after build.");
      const retained = await persist();
      expect(retained.source.integrity).toBe(source.source.integrity);
      expect(await readFile(join(retained.source.packageRoot, "CLAW.md"), "utf8")).toBe(manifest);
      await expect(
        readFile(join(retained.source.packageRoot, "private.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      return retained.source.integrity;
    },
  });
  expect(result.value).toMatch(/^sha256:[a-f0-9]{64}$/);
});

it("rejects relative Gateway-host paths before source access", async () => {
  await expect(
    withResolvedTemplateAddSource({
      coordinate: { kind: "local", path: "relative" },
      mode: "preview",
      run: async () => undefined,
    }),
  ).rejects.toThrow("absolute paths");
});

async function uploadFixture() {
  const root = dirs.make("upload-project-");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "@fixture/upload-template",
      version: "1.0.0",
      openclaw: { template: "CLAW.md" },
    }),
  );
  await writeFile(
    join(root, "CLAW.md"),
    "---\nschemaVersion: 1\nagent: { id: upload-template }\n---\nUploaded instructions.\n",
  );
  const archive = join(dirs.make("upload-archive-"), "template.tgz");
  return { root, archive };
}

it("keeps exact uploaded bytes and identity through preview and retained apply", async () => {
  const { root, archive } = await uploadFixture();
  const stateDir = dirs.make("upload-state-");
  tar.c({ cwd: root, file: archive, gzip: false, sync: true, prefix: "package" }, [
    "package.json",
    "CLAW.md",
  ]);
  await writeFile(archive, gzipSync(await readFile(archive)));
  const bytes = await readFile(archive);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const coordinate = { kind: "upload" as const, archiveBase64: bytes.toString("base64") };
  for (const mode of ["preview", "apply"] as const) {
    const onStage = vi.fn();
    await withResolvedTemplateAddSource({
      coordinate,
      onStage,
      mode,
      stateDir,
      run: async (source, trust, persist) => {
        expect(onStage.mock.calls).toEqual([
          ["upload_decode_and_staging"],
          ["upload_extraction"],
          ["upload_validation"],
        ]);
        expect(source.source.integrity).toBe(`sha256:${digest}`);
        expect(source.source.byteLength).toBe(bytes.length);
        expect(trust.trustWarning).toContain("not published to or scanned");
        if (mode === "preview") {
          await expect(persist()).rejects.toThrow("preview cannot persist");
        } else {
          const retained = await persist();
          expect(await readFile(join(retained.source.packageRoot, "CLAW.md"), "utf8")).toContain(
            "Uploaded instructions",
          );
          expect(await readFile(join(stateDir, "templates", "sources", `${digest}.tgz`))).toEqual(
            bytes,
          );
        }
      },
    });
  }
});

it.each(["!!!!", "YWJj", "", "A".repeat(1398108), Buffer.alloc(1048577).toString("base64")])(
  "rejects malformed or oversized uploads with a safe actionable error (%#)",
  async (archiveBase64) => {
    const onStage = vi.fn();
    await expect(
      withResolvedTemplateAddSource({
        onStage,
        coordinate: { kind: "upload", archiveBase64 },
        mode: "preview",
        run: async () => undefined,
      }),
    ).rejects.toMatchObject({
      name: "ClawHubSourceError",
      code: "template_upload_invalid",
      message: expect.stringContaining("valid .tgz Template project"),
    });
    expect(onStage.mock.calls.at(-1)?.[0]).toBe(
      archiveBase64 === "YWJj" ? "upload_extraction" : "upload_decode_and_staging",
    );
  },
);

it.each(["symlink", "hardlink", "traversal", "expanded-size", "invalid-project"])(
  "rejects unsafe uploaded archives: %s",
  async (kind) => {
    const { root, archive } = await uploadFixture();
    const files = ["package.json", "CLAW.md"];
    if (kind === "symlink") {
      await symlink("CLAW.md", join(root, "link"));
      files.push("link");
    }
    if (kind === "hardlink") {
      await link(join(root, "CLAW.md"), join(root, "link"));
      files.push("link");
    }
    if (kind === "expanded-size") {
      await writeFile(join(root, "huge"), Buffer.alloc(1048577));
      files.push("huge");
    }
    if (kind === "invalid-project") {
      await writeFile(join(root, "package.json"), "{}");
    }
    tar.c(
      {
        cwd: root,
        file: archive,
        gzip: false,
        sync: true,
        prefix: kind === "traversal" ? "../escape" : "package",
      },
      files,
    );
    await writeFile(archive, gzipSync(await readFile(archive)));
    const onStage = vi.fn();
    await expect(
      withResolvedTemplateAddSource({
        onStage,
        coordinate: { kind: "upload", archiveBase64: (await readFile(archive)).toString("base64") },
        mode: "preview",
        run: async () => {
          throw new Error("unsafe archive reached lifecycle");
        },
      }),
    ).rejects.toMatchObject({ name: "ClawHubSourceError", code: "template_upload_invalid" });
    expect(onStage.mock.calls.at(-1)?.[0]).toBe(
      kind === "invalid-project" ? "upload_validation" : "upload_extraction",
    );
  },
);
