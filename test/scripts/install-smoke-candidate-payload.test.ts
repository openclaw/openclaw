import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  sealInstallSmokeCandidatePayload,
  verifyInstallSmokeCandidatePayload,
} from "../../scripts/install-smoke-candidate-payload.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const IDENTITY = {
  harnessRepository: "openclaw/openclaw",
  harnessSha: "1".repeat(40),
  repository: "openclaw/openclaw",
  runAttempt: "2",
  runId: "12345",
  targetSha: "2".repeat(40),
};
const PACKAGE_VERSION = "2026.8.1-beta.3";
const POLICY_INCLUDE =
  '#!/bin/bash\nsource "${BASH_SOURCE[0]%${BASH_SOURCE[0]##*/}}./install-policy.sh"\n';
type FixtureOptions = { symlinkInstaller?: boolean; symlinkPackage?: boolean };
const write = (dir: string, name: string, content: string) =>
  fs.writeFileSync(path.join(dir, name), content);
const read = (dir: string, name: string) => fs.readFileSync(path.join(dir, name), "utf8");

function sha256(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function createTarball(archivePath: string, sourceDir: string, entries: string[]): void {
  execFileSync("tar", ["-czf", archivePath, "-C", sourceDir, ...entries], {
    // The candidate packer runs in Linux; prevent macOS tar from adding AppleDouble files.
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
}

function createFixture(options: FixtureOptions = {}) {
  const root = tempDirs.make("install-smoke-candidate-payload-");
  const scriptsDir = path.join(root, "candidate-root/scripts");
  const packageRoot = path.join(root, "package-root");
  const packageContents = path.join(packageRoot, "package");
  const packageDir = path.join(root, "package-output");
  const payloadDir = path.join(root, "payload");
  for (const dir of [scriptsDir, packageContents, packageDir, payloadDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  write(scriptsDir, "install-target.sh", "#!/bin/sh\necho install\n");
  if (options.symlinkInstaller) {
    fs.symlinkSync("install-target.sh", path.join(scriptsDir, "install.sh"));
  } else {
    write(scriptsDir, "install.sh", "#!/bin/sh\necho install\n");
  }
  write(scriptsDir, "install-cli.sh", "#!/bin/sh\necho cli\n");
  const archivePath = path.join(root, "candidate.tar.gz");
  createTarball(archivePath, root, ["candidate-root"]);

  write(
    packageContents,
    "package.json",
    `${JSON.stringify({ name: "openclaw", version: PACKAGE_VERSION })}\n`,
  );
  write(packageContents, "index.js", "console.log('openclaw');\n");
  const packagePath = path.join(packageDir, "candidate.tgz");
  createTarball(packagePath, packageRoot, ["package"]);
  if (options.symlinkPackage) {
    fs.unlinkSync(packagePath);
    fs.symlinkSync(path.join(root, "candidate.tar.gz"), packagePath);
  }
  return { archivePath, packageDir, packagePath, packageContents, payloadDir, root, scriptsDir };
}

async function sealFixture() {
  const fixture = createFixture();
  const manifest = await seal(fixture);
  const manifestPath = path.join(fixture.payloadDir, "install-smoke-candidate-payload.json");
  return { ...fixture, manifest, manifestSha256: sha256(manifestPath) };
}

function seal(fixture: ReturnType<typeof createFixture>) {
  return sealInstallSmokeCandidatePayload({
    ...IDENTITY,
    archivePath: fixture.archivePath,
    outputDir: fixture.payloadDir,
    packageDir: fixture.packageDir,
  });
}

function verify(
  fixture: Awaited<ReturnType<typeof sealFixture>>,
  overrides: Partial<Parameters<typeof verifyInstallSmokeCandidatePayload>[0]> = {},
) {
  return verifyInstallSmokeCandidatePayload({
    ...IDENTITY,
    expectedManifestSha256: fixture.manifestSha256,
    expectedPackageVersion: PACKAGE_VERSION,
    expectedSourceArchiveSha256: fixture.manifest.sourceArchiveSha256,
    payloadDir: fixture.payloadDir,
    ...overrides,
  });
}

describe("install smoke candidate payload", () => {
  it("inlines archived policy without executing candidate code or reading mutable sources", async () => {
    const fixture = createFixture();
    const marker = path.join(fixture.root, "executed");
    write(fixture.scriptsDir, "install.sh", `${POLICY_INCLUDE}echo install\n`);
    write(fixture.scriptsDir, "install-policy.sh", `touch '${marker}'\n`);
    createTarball(fixture.archivePath, fixture.root, ["candidate-root"]);
    write(fixture.scriptsDir, "install-policy.sh", "mutable source must not be used\n");
    await seal(fixture);
    expect(fs.existsSync(marker)).toBe(false);
    expect(read(fixture.payloadDir, "install.sh")).toBe(
      `#!/bin/bash\ntouch '${marker}'\necho install\n`,
    );
  });

  it("seals source installers and package bytes into a fully bound payload", async () => {
    const fixture = await sealFixture();
    const verified = await verify(fixture);

    expect(verified).toEqual(fixture.manifest);
    expect(verified).toMatchObject({
      ...IDENTITY,
      packageVersion: PACKAGE_VERSION,
      schema: "openclaw.install-smoke-candidate-payload/v1",
      sourceArchiveSha256: sha256(fixture.archivePath),
    });
    expect(verified.files.map(({ name, role }) => ({ name, role }))).toEqual([
      { name: "candidate.tgz", role: "package" },
      { name: "candidate-pack.json", role: "package-metadata" },
      { name: "install.sh", role: "installer" },
      { name: "install-cli.sh", role: "cli-installer" },
    ]);
    expect(JSON.parse(read(fixture.payloadDir, "candidate-pack.json"))).toEqual([
      {
        entryCount: 2,
        filename: "candidate.tgz",
        name: "openclaw",
        size: fs.statSync(fixture.packagePath).size,
        unpackedSize:
          fs.statSync(path.join(fixture.packageContents, "package.json")).size +
          fs.statSync(path.join(fixture.packageContents, "index.js")).size,
        version: PACKAGE_VERSION,
      },
    ]);
    expect(read(fixture.payloadDir, "install.sh")).toContain("echo install");
  });

  it("rejects a policy include backed by an archive symlink", async () => {
    const fixture = createFixture();
    write(fixture.scriptsDir, "install.sh", POLICY_INCLUDE);
    fs.symlinkSync("install-target.sh", path.join(fixture.scriptsDir, "install-policy.sh"));
    createTarball(fixture.archivePath, fixture.root, ["candidate-root"]);
    await expect(seal(fixture)).rejects.toThrow("scripts/install-policy.sh must be a regular file");
  });

  it.each([
    ["install-cli.sh", "tampered\n", "candidate payload digest does not match for install-cli.sh"],
    [
      "install-smoke-candidate-payload.json",
      "{}\n",
      "candidate payload manifest digest does not match producer output",
    ],
    ["extra", "unexpected\n", "candidate payload contains missing or unexpected files"],
  ] as const)("rejects tampering with %s after sealing", async (name, content, error) => {
    const fixture = await sealFixture();
    write(fixture.payloadDir, name, content);
    await expect(verify(fixture)).rejects.toThrow(error);
  });

  it.each([
    [
      { targetSha: "3".repeat(40) },
      "candidate payload manifest targetSha does not match the expected tuple",
    ],
    [
      { expectedSourceArchiveSha256: "4".repeat(64) },
      "candidate payload source archive digest does not match producer output",
    ],
  ] as const)("rejects tuple drift %j", async (overrides, error) => {
    await expect(verify(await sealFixture(), overrides)).rejects.toThrow(error);
  });

  it.each([
    [{ symlinkInstaller: true }, "scripts/install.sh must be a regular file"],
    [{ symlinkPackage: true }, "candidate package tarball must be a regular file"],
  ] as const)("rejects symlinked candidate inputs %j before sealing", async (options, error) => {
    await expect(seal(createFixture(options))).rejects.toThrow(error);
  });
});
