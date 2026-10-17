import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, it, expect, vi } from "vitest";
import { mockNodeBuiltinModule } from "../plugin-sdk/test-helpers/node-builtin-mocks.js";

afterEach(() => {
  vi.doUnmock("node:module");
  vi.doUnmock("../infra/git-commit.js");
  vi.resetModules();
});

it("records the loaded build after the installation changes before failure", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-stability-build-"));
  const metadataPath = path.join(root, "build-info.json");
  const readBuild = () => JSON.parse(fs.readFileSync(metadataPath, "utf8")) as { commit: string };
  const loadedCommit = vi.fn(() => readBuild().commit.slice(0, 7));
  try {
    fs.writeFileSync(
      metadataPath,
      JSON.stringify({
        version: "2026.4.22-beta.1+fixture",
        buildId: "build-a",
        commit: "a".repeat(40),
      }),
    );
    // Redirect only the metadata dependency; exercise the real runtime identity
    // owner before loading the failure writer, as Gateway startup does.
    vi.doMock("node:module", (importOriginal) =>
      mockNodeBuiltinModule(
        () => importOriginal<typeof import("node:module")>(),
        (actual) => ({
          createRequire: (moduleUrl: string | URL) =>
            new Proxy(actual.createRequire(moduleUrl), {
              apply(target, thisArg, args: unknown[]) {
                if (typeof args[0] === "string" && args[0].endsWith("build-info.json")) {
                  return readBuild();
                }
                return Reflect.apply(target, thisArg, args);
              },
            }),
        }),
      ),
    );
    vi.doMock("../infra/git-commit.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../infra/git-commit.js")>()),
      resolveLoadedCommitHash: loadedCommit,
    }));
    vi.resetModules();
    await import("../version.js");

    fs.writeFileSync(
      metadataPath,
      JSON.stringify({
        version: "2026.4.23",
        buildId: "build-b",
        commit: "b".repeat(40),
      }),
    );
    const { writeDiagnosticStabilityBundleForFailureSync, readDiagnosticStabilityBundleFileSync } =
      await import("./diagnostic-stability-bundle.js");
    const written = writeDiagnosticStabilityBundleForFailureSync(
      "gateway.stop_close_failed",
      undefined,
      { stateDir: root },
    );
    expect(written.status).toBe("written");
    if (written.status !== "written") {
      throw new Error("Expected written stability bundle");
    }
    const readback = readDiagnosticStabilityBundleFileSync(written.path);
    expect(readback.status).toBe("found");
    if (readback.status !== "found") {
      throw new Error("Expected readable stability bundle");
    }
    expect(readback.bundle.process).toMatchObject({
      openclawVersion: "2026.4.22-beta.1+fixture",
      buildId: "build-a",
      commit: "aaaaaaa",
    });
    expect(loadedCommit).toHaveBeenCalledOnce();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
