import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const RUNNER_PATH = join(process.cwd(), "scripts/e2e/lib/docker-package-identity.sh");

type Manager = "bun" | "npm" | "pnpm";
type PackageIdentityOptions = {
  artifactVersion: string;
  nativeContract?: "required" | "not-applicable";
} & Partial<Record<`${Manager}${"Cli" | "Manifest"}`, string>>;
const mismatches = [
  ["Manifest", "11.2.30", "installed manifest version '11.2.30' != artifact '1.2.3'"],
  ["Cli", "OpenClaw 11.2.30 (wrong)", "CLI output parses to '11.2.30'"],
] as const;

function runPackageIdentity(options: PackageIdentityOptions) {
  const root = tempDirs.make("openclaw-docker-package-identity-");
  const binDir = join(root, "bin");
  const packageDir = join(root, "package");
  const packageTgz = join(root, "candidate.tgz");
  const identityPath = join(root, "identity.json");
  mkdirSync(binDir);
  mkdirSync(packageDir);
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({ name: "openclaw", version: options.artifactVersion }),
  );
  const pack = spawnSync("tar", ["-czf", packageTgz, "-C", root, "package"], {
    encoding: "utf8",
  });
  expect(pack.status, pack.stderr).toBe(0);

  const dockerPath = join(binDir, "docker");
  writeFileSync(
    dockerPath,
    `#!/usr/bin/env node
const [command, ...args] = process.argv.slice(2);
if (command === 'inspect') {
  console.log(JSON.stringify([{ Id: 'sha256:fake', Image: 'sha256:image', Name: '/' + args.at(-1), RepoDigests: [], State: { Status: 'running' } }]));
  process.exit(0);
}
if (command !== 'exec') process.exit(2);
const [container, ...parts] = args;
if (!container) { console.error('missing container'); process.exit(1); }
const text = parts.join(' ');
const manager = container.toUpperCase();
const bunFields = {
  installedPackageRoot: '/fake/bun/openclaw', installedPackageVersion: process.env.FAKE_BUN_MANIFEST,
  openclawVersion: process.env.FAKE_BUN_CLI, openclawPath: '/fake/bun/bin/openclaw',
};
const responses = [
  [text === 'cat /tmp/openclaw-package-root', '/fake/pnpm/openclaw'],
  [text === 'cat /tmp/openclaw-version', manager && process.env['FAKE_' + manager + '_CLI']],
  [text.includes('/tmp/openclaw-bun-proof.json'), Object.entries(bunFields).find(([field]) => text.includes(field))?.[1]],
  [text.includes('package.json'), manager && process.env['FAKE_' + manager + '_MANIFEST']],
];
const response = responses.find(([matches]) => matches);
if (!response || response[1] === undefined) process.exit(2);
process.stdout.write(response[1]);
`,
    { mode: 0o755 },
  );

  const result = spawnSync(
    "/bin/bash",
    [RUNNER_PATH, packageTgz, identityPath, "image", "npm", "pnpm", "bun", "musl"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_BUN_CLI: options.bunCli ?? `OpenClaw ${options.artifactVersion}`,
        FAKE_BUN_MANIFEST: options.bunManifest ?? options.artifactVersion,
        FAKE_NPM_CLI: options.npmCli ?? `OpenClaw ${options.artifactVersion}`,
        FAKE_NPM_MANIFEST: options.npmManifest ?? options.artifactVersion,
        FAKE_PNPM_CLI: options.pnpmCli ?? `OpenClaw ${options.artifactVersion}`,
        FAKE_PNPM_MANIFEST: options.pnpmManifest ?? options.artifactVersion,
        OPENCLAW_FS_SAFE_NATIVE_CONTRACT: options.nativeContract ?? "required",
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      },
    },
  );
  return {
    identity: result.status === 0 ? JSON.parse(readFileSync(identityPath, "utf8")) : undefined,
    result,
  };
}

describe.skipIf(process.platform === "win32")("Docker package identity report", () => {
  it.each(mismatches)(
    "rejects a stale npm %s version even when it contains the artifact version",
    (field, value, diagnostic) => {
      const { result } = runPackageIdentity({
        artifactVersion: "1.2.3",
        [`npm${field}`]: value,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`[npm] ${diagnostic}`);
    },
  );

  it.each([
    { version: "2026.6.21-beta.1+build.7", nativeContract: "not-applicable" },
    { version: "1.2.3-beta-rc.1+build.7", nativeContract: "required" },
  ] as const)(
    "emits complete manager-owned identity for $version with the $nativeContract native contract",
    ({ version, nativeContract }) => {
      const { identity, result } = runPackageIdentity({ artifactVersion: version, nativeContract });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(identity).toMatchObject({ package: { version } });
      const container = (role: string, details: Record<string, string>) => {
        expect(identity.containers).toContainEqual(
          expect.objectContaining({ role, details: expect.objectContaining(details) }),
        );
      };
      container("musl", {
        fsSafeNative: nativeContract === "required" ? "passed" : "not-applicable",
      });
      for (const [role, installedPackageRoot] of [
        ["npm", "/usr/local/lib/node_modules/openclaw"],
        ["pnpm", "/fake/pnpm/openclaw"],
        ["bun", "/fake/bun/openclaw"],
      ] as const) {
        container(role, {
          installedPackageRoot,
          installedPackageVersion: version,
          parsedOpenclawVersion: version,
        });
      }
    },
  );
});
