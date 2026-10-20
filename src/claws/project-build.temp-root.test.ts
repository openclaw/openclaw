import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { extractBuiltClawArtifact } from "./project-build.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { tempRoot } = vi.hoisted(() => ({ tempRoot: { shared: "", private: "" } }));

vi.mock("../infra/tmp-openclaw-dir.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/tmp-openclaw-dir.js")>();
  return {
    ...actual,
    resolvePreferredOpenClawTmpDir: () =>
      actual.resolvePreferredOpenClawTmpDir({
        preferredDir: tempRoot.private,
        tmpdir: () => tempRoot.shared,
      }),
  };
});

afterEach(() => vi.unstubAllEnvs());

it.runIf(process.platform !== "win32")(
  "extracts and disposes an artifact when the system temp directory is shared",
  async () => {
    tempRoot.shared = tempDirs.make("openclaw-claw-shared-temp-");
    tempRoot.private = path.join(tempRoot.shared, "openclaw");
    await fs.chmod(tempRoot.shared, 0o1777);
    const source = tempDirs.make("openclaw-claw-artifact-source-");
    await fs.mkdir(path.join(source, "package"));
    await fs.writeFile(path.join(source, "package", "CLAW.md"), "artifact content");
    const artifact = path.join(source, "claw.tgz");
    await tar.c({ cwd: source, file: artifact, gzip: true }, ["package"]);
    vi.stubEnv("TMPDIR", tempRoot.shared);

    const extracted = await extractBuiltClawArtifact(artifact);
    try {
      await expect(fs.readFile(path.join(extracted.packageRoot, "CLAW.md"), "utf8")).resolves.toBe(
        "artifact content",
      );
      expect(path.dirname(path.dirname(extracted.packageRoot))).toBe(tempRoot.private);
      expect((await fs.stat(tempRoot.private)).mode & 0o7777).toBe(0o700);
      expect((await fs.stat(tempRoot.shared)).mode & 0o7777).toBe(0o1777);
    } finally {
      await extracted[Symbol.asyncDispose]();
    }
    await expect(fs.stat(path.dirname(extracted.packageRoot))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);
