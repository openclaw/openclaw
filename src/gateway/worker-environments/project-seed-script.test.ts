import { execFile, execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, assert, describe, expect, it } from "vitest";
import { bindGitInvocation } from "../../../scripts/pr-lib/git-invocation.mjs";
import { listenLoopback } from "../../../test/helpers/gateway-integration-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveExecutablePath } from "../../infra/executable-path.js";
import { gitMaintenanceEnvironment } from "../../infra/git-maintenance-env.js";
import { createProjectSeedScript } from "./project-seed-script.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const url = "https://github.com/openclaw/synthetic-preparation.git";
const token = "synthetic-inherited-project-token";
const execFileAsync = promisify(execFile);
const read = (file: string) => fs.readFile(file, "utf8");
async function expectAbsent(...files: string[]) {
  for (const file of files) {
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  }
}
function expectReady(result: SpawnSyncReturns<string>) {
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ ready: true });
}

async function fixture(fail = false, networkUrl?: string) {
  const root = await fs.realpath(tempDirs.make("project-seed-script-"));
  const home = path.join(root, "home's directory");
  const repository = path.join(root, "source");
  const bin = path.join(root, "bin");
  await Promise.all([home, repository, bin].map((dir) => fs.mkdir(dir)));
  const selectedGit = resolveExecutablePath("git", { cwd: process.cwd(), useCache: false });
  assert(selectedGit, "Project seed fixture requires git");
  // Keep a policy launcher's backend discovery outside the fixture shim's PATH;
  // otherwise its bare Git delegation can recursively select that same shim.
  const realGit = bindGitInvocation(
    tempDirs.make("project-seed-host-git-"),
    selectedGit,
  ).executable;
  const git = (cwd: string, args: string[]) =>
    execFileSync(realGit, ["-C", cwd, ...args], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: home,
        GIT_CONFIG_GLOBAL: os.devNull,
        GIT_CONFIG_NOSYSTEM: "1",
      },
    }).trim();
  const codeWitness = path.join(root, "repository-code-ran");
  const setupScript = `#!/bin/sh\nprintf 'unexpected setup execution\\n' > '${codeWitness}'\nexit 97\n`;
  await fs.mkdir(path.join(repository, ".openclaw"));
  await fs.writeFile(path.join(repository, ".openclaw", "worktree-setup.sh"), setupScript, {
    mode: 0o755,
  });
  git(repository, ["init", "--quiet"]);
  git(repository, ["config", "user.name", "Seed Test"]);
  git(repository, ["config", "user.email", "seed@example.invalid"]);
  await fs.writeFile(path.join(repository, "input.txt"), "pinned A\n");
  git(repository, ["add", "."]);
  git(repository, ["commit", "--quiet", "-m", "A"]);
  const baseCommit = git(repository, ["rev-parse", "HEAD"]);
  await fs.writeFile(path.join(repository, "input.txt"), "later B\n");
  git(repository, ["commit", "--quiet", "-am", "B"]);
  await fs.writeFile(path.join(repository, "untracked.txt"), "must not transfer\n");
  const witness = path.join(root, "fetches");
  const inheritedAuthWitness = path.join(root, "inherited-auth-keys.json");
  const authHomeWitness = path.join(root, "fetch-auth-home.json");
  const askpassWitness = path.join(root, "inherited-askpass-ran");
  const askpass = path.join(bin, "inherited-askpass");
  await fs.writeFile(
    askpass,
    `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(askpassWitness)}, "unexpected inherited authentication");\nprocess.exit(98);\n`,
    { mode: 0o700 },
  );
  // Only the network boundary is replaced; object transfer and verification use real Git.
  const shim = path.join(bin, "git");
  await fs.writeFile(
    shim,
    `#!${process.execPath}
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args.includes("fetch") && args.includes(${JSON.stringify(url)})) {
  for (const flag of ["--depth=1", "--no-write-fetch-head", "--no-recurse-submodules", "http.followRedirects=false", "protocol.allow=never", "credential.helper="]) assert(args.includes(flag));
  assert.equal(args.at(-1), ${JSON.stringify(baseCommit)});
  assert.deepEqual(Object.fromEntries(Object.entries(process.env).filter(([key]) => /^GIT_CONFIG_(COUNT|KEY_[0-9]+|VALUE_[0-9]+)$/i.test(key))), ${JSON.stringify(gitMaintenanceEnvironment())});
  const inheritedAuthKeys = ["GIT_TRACE", "GH_TOKEN", "GITHUB_TOKEN", "Git_Trace", "gh_token", "GitHub_Token"].filter((key) => process.env[key] !== undefined);
  fs.writeFileSync(${JSON.stringify(inheritedAuthWitness)}, JSON.stringify(inheritedAuthKeys));
  assert.deepEqual(inheritedAuthKeys, []);
  assert.equal(process.env.GIT_CONFIG_GLOBAL, require("node:os").devNull);
  assert.equal(process.env.GIT_ASKPASS, "");
  assert.equal(process.env.SSH_ASKPASS, "");
  assert.equal(process.env.GIT_TERMINAL_PROMPT, "0");
  assert(!args.join(" ").includes(${JSON.stringify(token)}));
  fs.writeFileSync(${JSON.stringify(authHomeWitness)}, JSON.stringify({
    inheritedHome: process.env.HOME === ${JSON.stringify(home)},
    inheritedUserProfile: process.env.USERPROFILE === ${JSON.stringify(home)},
    netrcOverridePresent: Object.keys(process.env).some((key) => /^NETRC$/i.test(key)),
  }));
  fs.appendFileSync(${JSON.stringify(witness)}, "fetch\\n");
  if (${fail}) {
    fs.writeSync(2, "synthetic remote fetch diagnostic\\n".repeat(20000));
    process.exit(17);
  }
  args.splice(args.indexOf(${JSON.stringify(url)}), 1, ${JSON.stringify(networkUrl ?? repository)});
  args.unshift("-c", ${JSON.stringify(networkUrl ? "protocol.http.allow=always" : "protocol.file.allow=always")});
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { env: process.env, stdio: "inherit" });
process.exit(result.status ?? 1);
`,
    { mode: 0o700 },
  );
  const input = { namespace: "gateway", seedKey: "a".repeat(64), baseCommit };
  type SeedOptions = Omit<Parameters<typeof createProjectSeedScript>[0], keyof typeof input>;
  const command = (extra: SeedOptions = {}) => [
    "-c",
    createProjectSeedScript({ ...input, ...extra }),
  ];
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    GIT_ASKPASS: askpass,
    SSH_ASKPASS: askpass,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "unwanted-helper",
    GIT_TRACE: "1",
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    git_config_count: "1",
    git_config_key_0: "http.https://github.com/.extraheader",
    git_config_value_0: `Authorization: Bearer ${token}`,
    Git_Trace: "1",
    gh_token: token,
    GitHub_Token: token,
  };
  const run = (extra: SeedOptions = {}) =>
    spawnSync("sh", command(extra), {
      encoding: "utf8",
      timeout: 30_000,
      env,
    });
  const inspection = run();
  expect(inspection.status, inspection.stderr).toBe(0);
  const { directory } = JSON.parse(inspection.stdout) as { directory: string };
  return {
    directory,
    env,
    home,
    repository,
    git,
    witness,
    inheritedAuthWitness,
    authHomeWitness,
    codeWitness,
    askpassWitness,
    setupScript,
    run,
    runAsync: (inheritedEnv: NodeJS.ProcessEnv) =>
      execFileAsync("sh", command({ repository: { directory, url } }), {
        encoding: "utf8",
        timeout: 30_000,
        env: { ...env, ...inheritedEnv },
      }),
    transport: { directory, url },
    seed: path.join(path.dirname(directory), input.seedKey),
    baseCommit,
  };
}

describe("public repository project seeds", () => {
  it("refuses an HTTP authentication challenge without consulting the machine's netrc files", async () => {
    const authorizationPresent: boolean[] = [];
    await using server = createServer((request, response) => {
      authorizationPresent.push(request.headers.authorization !== undefined);
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="synthetic-test"' });
      response.end();
    });
    const f = await fixture(false, `${await listenLoopback(server)}/repository.git`);
    const netrc = "machine 127.0.0.1 login synthetic-user password synthetic-password\n";
    for (const name of [".netrc", "_netrc", "override.netrc"]) {
      await fs.writeFile(path.join(f.home, name), netrc, { mode: 0o600 });
    }
    await expect(
      f.runAsync({
        USERPROFILE: f.home,
        NETRC: path.join(f.home, "override.netrc"),
        netrc: path.join(f.home, "override.netrc"),
        NO_PROXY: "127.0.0.1",
        no_proxy: "127.0.0.1",
      }),
    ).rejects.toMatchObject({ code: 1, stderr: "Project repository fetch failed\n" });
    expect(authorizationPresent.length).toBeGreaterThan(0);
    expect(authorizationPresent).not.toContain(true);
    expect(JSON.parse(await read(f.authHomeWitness))).toEqual({
      inheritedHome: false,
      inheritedUserProfile: false,
      netrcOverridePresent: false,
    });
    expect(await fs.readdir(path.dirname(f.directory))).toEqual([]);
    expect(await read(path.join(f.home, ".netrc"))).toBe(netrc);
  });

  it("installs only the pinned Git objects without inherited authentication or executing repository code, then reuses them offline", async () => {
    const f = await fixture();
    expectReady(f.run({ repository: f.transport }));
    expect(JSON.parse(await read(f.inheritedAuthWitness))).toEqual([]);
    expect(await read(path.join(f.seed, "input.txt"))).toBe("pinned A\n");
    expect((await fs.readdir(f.seed)).toSorted()).toEqual([".git", ".openclaw", "input.txt"]);
    expect(await read(path.join(f.seed, ".openclaw", "worktree-setup.sh"))).toBe(f.setupScript);
    expect(f.git(f.seed, ["rev-parse", "HEAD"])).toBe(f.baseCommit);
    expect(f.git(f.seed, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(f.git(f.seed, ["remote", "get-url", "origin"])).toBe(url);
    expect(f.git(f.seed, ["status", "--porcelain"])).toBe("");
    expect(await read(path.join(f.seed, ".git", "config"))).not.toContain(token);
    await expectAbsent(path.join(f.seed, ".git", "FETCH_HEAD"), f.directory);
    await fs.rename(f.repository, `${f.repository}-offline`);
    expectReady(f.run());
    expect(await read(f.witness)).toBe("fetch\n");
    await expectAbsent(f.codeWitness, f.askpassWitness);
  });

  it("installs an enterprise repository pack without contacting its credentialed origin", async () => {
    const f = await fixture();
    const pack = execFileSync("git", ["-C", f.repository, "pack-objects", "--stdout", "--revs"], {
      input: `${f.baseCommit}\n`,
      env: f.env,
    });
    await fs.writeFile(path.join(f.directory, "base.pack"), pack);
    const enterpriseUrl = "https://ghe.example.test/acme/private-repo.git";
    expectReady(
      f.run({
        pack: {
          directory: f.directory,
          bytes: pack.byteLength,
          sha256: createHash("sha256").update(pack).digest("hex"),
          repositoryUrl: enterpriseUrl,
        },
      }),
    );
    expect(f.git(f.seed, ["remote", "get-url", "origin"])).toBe(enterpriseUrl);
    await expectAbsent(f.witness);
  });

  it("returns a bounded generic failure and removes staging when public fetch emits excessive diagnostics", async () => {
    const f = await fixture(true);
    expect(f.run({ repository: f.transport })).toMatchObject({
      status: 1,
      stderr: "Project repository fetch failed\n",
      stdout: "",
    });
    expect(await read(f.witness)).toBe("fetch\n");
    expect(await fs.readdir(path.dirname(f.directory))).toEqual([]);
    await expectAbsent(f.codeWitness, f.askpassWitness);
  });
});
