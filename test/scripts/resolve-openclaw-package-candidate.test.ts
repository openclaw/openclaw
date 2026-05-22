import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  downloadUrl,
  parseArgs,
  readArtifactPackageCandidateMetadata,
  readPackageBuildSourceSha,
  validateOpenClawPackageSpec,
} from "../../scripts/resolve-openclaw-package-candidate.mjs";

const tempDirs: string[] = [];

type LookupAddress = { address: string; family: number };

function lookupAddresses(addresses: LookupAddress[]) {
  return async () => addresses;
}

function unexpectedFetch(): never {
  throw new Error("downloadUrl should reject before fetching");
}

async function missing(file: string): Promise<boolean> {
  return await access(file).then(
    () => false,
    () => true,
  );
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("resolve-openclaw-package-candidate", () => {
  it("accepts only OpenClaw release package specs for npm candidates", () => {
    for (const spec of [
      "openclaw@beta",
      "openclaw@alpha",
      "openclaw@latest",
      "openclaw@2026.4.27",
      "openclaw@2026.4.27-1",
      "openclaw@2026.4.27-beta.2",
      "openclaw@2026.4.27-alpha.2",
    ]) {
      expect(validateOpenClawPackageSpec(spec), spec).toBeUndefined();
    }

    expect(() => validateOpenClawPackageSpec("@evil/openclaw@1.0.0")).toThrow(
      "package_spec must be openclaw@alpha",
    );
    expect(() => validateOpenClawPackageSpec("openclaw@canary")).toThrow(
      "package_spec must be openclaw@alpha",
    );
    expect(() => validateOpenClawPackageSpec("openclaw@2026.04.27")).toThrow(
      "package_spec must be openclaw@alpha",
    );
    expect(() => validateOpenClawPackageSpec("openclaw@npm:other-package")).toThrow(
      "package_spec must be openclaw@alpha",
    );
    expect(() => validateOpenClawPackageSpec("openclaw@file:../other-package.tgz")).toThrow(
      "package_spec must be openclaw@alpha",
    );
  });

  it("parses optional empty workflow inputs without rejecting the command line", () => {
    expect(
      parseArgs([
        "--source",
        "npm",
        "--package-ref",
        "release/2026.4.27",
        "--package-spec",
        "openclaw@beta",
        "--package-url",
        "",
        "--package-sha256",
        "",
        "--artifact-dir",
        ".",
        "--output-dir",
        ".artifacts/docker-e2e-package",
      ]),
    ).toEqual({
      artifactDir: ".",
      githubOutput: "",
      metadata: "",
      outputDir: ".artifacts/docker-e2e-package",
      outputName: "openclaw-current.tgz",
      packageSha256: "",
      packageRef: "release/2026.4.27",
      packageSpec: "openclaw@beta",
      packageUrl: "",
      source: "npm",
    });
  });

  it("rejects unsafe package_url downloads before fetching private targets", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-download-"));
    tempDirs.push(dir);
    const target = path.join(dir, "openclaw.tgz");

    await expect(
      downloadUrl("http://packages.example/openclaw.tgz", target, {
        fetchImpl: unexpectedFetch,
        lookupHost: lookupAddresses([{ address: "93.184.216.34", family: 4 }]),
      }),
    ).rejects.toThrow("package_url must use https");
    await expect(
      downloadUrl("https://user@packages.example/openclaw.tgz", target, {
        fetchImpl: unexpectedFetch,
        lookupHost: lookupAddresses([{ address: "93.184.216.34", family: 4 }]),
      }),
    ).rejects.toThrow("package_url must not include credentials");
    await expect(
      downloadUrl("https://localhost/openclaw.tgz", target, {
        fetchImpl: unexpectedFetch,
        lookupHost: lookupAddresses([{ address: "127.0.0.1", family: 4 }]),
      }),
    ).rejects.toThrow(/private\/internal\/special-use/iu);
    await expect(
      downloadUrl("https://packages.example/openclaw.tgz", target, {
        fetchImpl: unexpectedFetch,
        lookupHost: lookupAddresses([{ address: "10.0.0.8", family: 4 }]),
      }),
    ).rejects.toThrow(/resolves to private\/internal\/special-use/iu);
  });

  it("validates redirects for package_url downloads", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-download-"));
    tempDirs.push(dir);
    const target = path.join(dir, "openclaw.tgz");
    const requestedUrls: string[] = [];

    await expect(
      downloadUrl("https://packages.example/openclaw.tgz", target, {
        fetchImpl: async (url: URL) => {
          requestedUrls.push(url.toString());
          return new Response(null, {
            headers: { location: "https://169.254.169.254/latest/meta-data" },
            status: 302,
          });
        },
        lookupHost: lookupAddresses([{ address: "93.184.216.34", family: 4 }]),
      }),
    ).rejects.toThrow(/private\/internal\/special-use/iu);
    expect(requestedUrls).toEqual(["https://packages.example/openclaw.tgz"]);
  });

  it("cancels redirect response bodies before following the next hop", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-download-"));
    tempDirs.push(dir);
    const target = path.join(dir, "openclaw.tgz");
    const bodyCancelled: string[] = [];

    await expect(
      downloadUrl("https://packages.example/openclaw.tgz", target, {
        fetchImpl: async (url: URL) => {
          const body = new ReadableStream({
            start(controller) {
              // Simulate a slow/never-ending body that would hang if not cancelled
              const timer = setInterval(() => {
                controller.enqueue(new Uint8Array([0]));
              }, 100);
              // Keep the stream open indefinitely
              return () => clearInterval(timer);
            },
            cancel(reason) {
              bodyCancelled.push(url.toString());
            },
          });
          return new Response(body, {
            headers: { location: "https://packages.example/redirected.tgz" },
            status: 302,
          });
        },
        lookupHost: lookupAddresses([{ address: "93.184.216.34", family: 4 }]),
        timeoutMs: 5000,
      }),
    ).rejects.toThrow();
    // The redirect body must have been cancelled, not left open
    expect(bodyCancelled.length).toBeGreaterThan(0);
  });

  it("bounds package_url downloads and writes completed files atomically", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-download-"));
    tempDirs.push(dir);
    const target = path.join(dir, "openclaw.tgz");

    await expect(
      downloadUrl("https://packages.example/openclaw.tgz", target, {
        fetchImpl: async () =>
          new Response(new Uint8Array([1, 2, 3, 4]), {
            headers: { "content-length": "4" },
            status: 200,
          }),
        lookupHost: lookupAddresses([{ address: "93.184.216.34", family: 4 }]),
        maxBytes: 3,
      }),
    ).rejects.toThrow("package_url exceeds maximum download size");
    await expect(missing(target)).resolves.toBe(true);
    await expect(missing(`${target}.tmp`)).resolves.toBe(true);

    await downloadUrl("https://packages.example/openclaw.tgz", target, {
      fetchImpl: async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-length": "3" },
          status: 200,
        }),
      lookupHost: lookupAddresses([{ address: "93.184.216.34", family: 4 }]),
      maxBytes: 3,
    });
    await expect(readFile(target)).resolves.toEqual(Buffer.from([1, 2, 3]));
    await expect(missing(`${target}.tmp`)).resolves.toBe(true);
  });

  it("reads package source metadata from package artifacts", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-candidate-"));
    tempDirs.push(dir);
    await writeFile(
      path.join(dir, "package-candidate.json"),
      JSON.stringify(
        {
          packageRef: "release/2026.4.30",
          packageSourceSha: "66ce632b9b7c5c7fdd3e66c739687d51638ad6e2",
          packageTrustedReason: "repository-branch-history",
          sha256: "a".repeat(64),
        },
        null,
        2,
      ),
    );

    await expect(readArtifactPackageCandidateMetadata(dir)).resolves.toEqual({
      packageRef: "release/2026.4.30",
      packageSourceSha: "66ce632b9b7c5c7fdd3e66c739687d51638ad6e2",
      packageTrustedReason: "repository-branch-history",
      sha256: "a".repeat(64),
    });
  });

  it("reads the source SHA from packed npm build metadata", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-build-info-"));
    tempDirs.push(dir);
    const root = path.join(dir, "package");
    await mkdir(path.join(root, "dist"), { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
    await writeFile(
      path.join(root, "dist", "build-info.json"),
      JSON.stringify({ commit: "66CE632B9B7C5C7FDD3E66C739687D51638AD6E2" }),
    );
    const tarball = path.join(dir, "openclaw.tgz");
    await new Promise<void>((resolve, reject) => {
      execFile("tar", ["-czf", tarball, "-C", dir, "package"], (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    await expect(readPackageBuildSourceSha(tarball)).resolves.toBe(
      "66ce632b9b7c5c7fdd3e66c739687d51638ad6e2",
    );
  });
});
