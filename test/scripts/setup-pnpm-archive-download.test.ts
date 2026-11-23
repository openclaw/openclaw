import fs from "node:fs";
import { createServer } from "node:http";
import { basename, delimiter, join, relative } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect } from "vitest";
import { parse } from "yaml";
import { createCommandTest } from "../helpers/command-fixture.js";
import { createPnpmArchiveFixture } from "./setup-pnpm-archive.test-support.js";

const it = createCommandTest();
const read = (file: string) => fs.readFileSync(file, "utf8");
const action = parse(read(".github/actions/setup-pnpm-store-cache/action.yml"));
function expectNoSeed(
  result: { status: number | null; stderr: string; stdout: string },
  calls: string,
) {
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("");
  expect(fs.existsSync(calls)).toBe(false);
}

describe("pinned pnpm cold bootstrap", () => {
  it.for([{ platform: "darwin" }, { arch: "riscv64" }, { glibc: false }])(
    "leaves unsupported hosts with Corepack: %j",
    async (options, { command }) => {
      const f = createPnpmArchiveFixture(command, options);
      expectNoSeed(await f.run(), f.calls);
    },
  );

  it("authenticates store, image and registry archives", async ({ command }) => {
    const f = createPnpmArchiveFixture(command);
    const archives = fs.readdirSync(f.registry);
    const phases = [
      { source: "image", corruptStore: [] },
      { source: "store", corruptStore: [] },
      { source: "image", corruptStore: archives },
      ...archives.map((name) => ({ source: "registry", corruptStore: [name] })),
    ];
    let downloads = 0;
    for (const [index, { source, corruptStore }] of phases.entries()) {
      for (const name of archives) {
        if (source === "image") {
          fs.copyFileSync(join(f.registry, name), join(f.image, name));
        } else {
          fs.writeFileSync(join(f.image, name), "corrupt image");
        }
      }
      for (const name of corruptStore) {
        fs.writeFileSync(join(f.store, "toolchain", name), "corrupt store");
      }
      const result = await f.run(
        source === "registry" ? {} : { COREPACK_ENABLE_NETWORK: "0", CURL_FIXTURE_EXIT: "35" },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).not.toBe("");
      const root = join(result.stdout.trim(), "v1/pnpm/12.15.0");
      expect(read(join(root, "pnpm"))).toBe("wrapper-fixture\n");
      expect(read(join(root, "node_modules/@pnpm/exe.linux-x64/pnpm"))).toBe("native-fixture\n");
      expect(JSON.parse(read(join(root, ".corepack")))).toEqual({
        locator: { name: "pnpm", reference: f.spec.slice(5) },
        bin: { pnpm: "./bin/pnpm.mjs", pnpx: "./bin/pnpx.mjs" },
        hash: f.spec.split("+")[1],
      });
      expect(fs.existsSync(f.calls)).toBe(source === "registry");
      if (source === "registry") {
        downloads += 1;
        expect(read(f.calls).trim().split("\n")).toHaveLength(downloads);
      }
      expect(fs.readdirSync(f.runner)).toHaveLength(index + 1);
      for (const name of archives) {
        expect(fs.readFileSync(join(f.store, "toolchain", name))).toEqual(
          fs.readFileSync(join(f.registry, name)),
        );
      }
    }
    expect(read(f.calls).trim().split("\n")).toHaveLength(2);
  });

  it.for([
    ["recovers a transient response", 503, 1, 2],
    ["recovers a connection reset", null, 1, 2],
    ["bounds persistent connection resets", null, 4, 3],
    ["bounds persistent transient failures", 503, 4, 3],
    ["does not retry permanent failures", 404, 4, 1],
  ] as const)("%s with real curl", async ([, status, failures, attempts], { command }) => {
    await command.lifetime.run(async () => {
      const server = createServer();
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Registry fixture did not acquire a TCP port");
        }
        const f = createPnpmArchiveFixture(command, {
          registryUrl: `http://127.0.0.1:${address.port}`,
        });
        let wrapperAttempts = 0;
        server.on("request", (request, response) => {
          const name = basename(request.url ?? "");
          if (name === "pnpm-12.15.0.tgz" && ++wrapperAttempts <= failures) {
            if (status === null) {
              request.socket.destroy();
              return;
            }
            response.writeHead(status).end();
            return;
          }
          response.end(fs.readFileSync(join(f.registry, name)));
        });
        const result = await f.run();
        expect(wrapperAttempts).toBe(attempts);
        if (failures === 1) {
          expect(result.status, result.stderr).toBe(0);
          expect(read(join(result.stdout.trim(), "v1/pnpm/12.15.0/pnpm"))).toBe(
            "wrapper-fixture\n",
          );
          expect(fs.readFileSync(join(f.store, "toolchain/pnpm-12.15.0.tgz"))).toEqual(
            fs.readFileSync(join(f.registry, "pnpm-12.15.0.tgz")),
          );
        } else {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain("Cannot download pinned pnpm archive");
          expect(result.stdout).toBe("");
          expect(fs.readdirSync(f.runner)).toEqual([]);
          expect(fs.readdirSync(f.store)).toEqual([]);
        }
      } finally {
        server.closeAllConnections();
        if (server.listening) {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
        }
      }
    });
  });

  it.for(["pnpm-12.15.0.tgz", "exe.linux-x64-12.15.0.tgz"])(
    "rejects substituted %s without incomplete state",
    async (name, { command }) => {
      const f = createPnpmArchiveFixture(command);
      fs.writeFileSync(join(f.registry, name), "substituted bytes");
      const result = await f.run();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("checksum mismatch");
      expect(result.stdout).toBe("");
      expect(fs.readdirSync(f.runner)).toEqual([]);
    },
  );

  it.for([
    { COREPACK_ENABLE_NETWORK: "0" },
    { COREPACK_NPM_REGISTRY: "https://registry.example.test" },
    { COREPACK_INTEGRITY_KEYS: '{"npm":[]}' },
  ])("retains owner policy without cold seeding: %j", async (env, { command }) => {
    const f = createPnpmArchiveFixture(command);
    expectNoSeed(await f.run(env), f.calls);
    expect(fs.readdirSync(f.runner)).toEqual([]);
  });

  it("ignores unknown versions and mismatched integrity", async ({ command }) => {
    const f = createPnpmArchiveFixture(command);
    for (const spec of [f.spec.replace("12.15.0", "12.11.2"), f.spec.replace(/.$/u, "z")]) {
      const result = await f.run({}, spec);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    }
    expect(fs.existsSync(f.calls)).toBe(false);
    expect(fs.readdirSync(f.runner)).toEqual([]);
  });
});

describe("pnpm shim installation", () => {
  it.for([
    { runnerOS: "Linux", configured: false },
    { runnerOS: "Windows", configured: false },
    { runnerOS: "Linux", configured: true },
  ])("uses a writable job directory: %j", async ({ runnerOS, configured }, { command }) => {
    const root = command.createTempDir("pnpm-shims-");
    const bin = join(root, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      join(bin, "corepack"),
      `#!/bin/sh
set -eu
if [ "$1" = enable ]; then
  destination="$FIXTURE_SYSTEM_BIN"
  if [ "\${2:-}" = --install-directory ]; then destination="$3"; fi
  ln -s "$FIXTURE_PNPM" "$destination/pnpm"
fi
`,
      { mode: 0o755 },
    );
    const pnpm = join(root, "pnpm");
    fs.writeFileSync(pnpm, "#!/bin/sh\necho 12.15.0\n", { mode: 0o755 });
    fs.chmodSync(bin, 0o555);
    const envFile = join(root, "env");
    const pathFile = join(root, "path");
    const configuredHome = join(root, "configured-pnpm");
    const step = action.runs.steps.find(
      (entry: { name: string }) => entry.name === "Setup pnpm from packageManager",
    );
    const result = await command
      .run("bash", ["-eu", "-c", step.run], {
        cwd: root,
        env: {
          PATH: `${bin}${delimiter}${process.env.PATH}`,
          RUNNER_OS: runnerOS,
          RUNNER_TEMP: root,
          GITHUB_ACTION_PATH: join(process.cwd(), ".github/actions/setup-pnpm-store-cache"),
          GITHUB_ENV: envFile,
          GITHUB_PATH: pathFile,
          COREPACK_ENABLE_NETWORK: "0",
          PACKAGE_MANAGER: "pnpm@12.15.0",
          FIXTURE_SYSTEM_BIN: bin,
          FIXTURE_PNPM: pnpm,
          ...(configured ? { PNPM_HOME: configuredHome } : {}),
        },
      })
      .finally(() => fs.chmodSync(bin, 0o755));
    expect(result.status, result.stderr).toBe(0);
    const home = read(pathFile).trim();
    expect(home).toEqual(
      configured ? configuredHome : expect.stringMatching(/^.+[/\\]openclaw-pnpm-bin-/u),
    );
    expect(read(envFile)).toContain(`PNPM_HOME=${home}\n`);
    expect(fs.existsSync(join(home, "pnpm"))).toBe(true);
  });
});

describe("pnpm version output owns its failure", () => {
  it("shares the store archive across hosted and Boat workspace layouts", async ({ command }) => {
    const root = command.createTempDir("pnpm-portable-store-");
    const workspaces = [
      join(root, "home/runner/work/repo/repo"),
      join(root, "boat/_work/repo/repo"),
    ];
    const resolve = action.runs.steps.find(
      (step: { name: string }) => step.name === "Resolve pnpm store path",
    );
    const restore = action.runs.steps.find(
      (step: { name: string }) => step.name === "Restore pnpm store cache",
    );
    const cachePaths: string[] = [];
    for (const workspace of workspaces) {
      fs.mkdirSync(workspace, { recursive: true });
      const output = join(workspace, "outputs");
      const envFile = join(workspace, "env");
      const result = await command.run("bash", ["-eu", "-c", resolve.run], {
        cwd: workspace,
        env: {
          PATH: process.env.PATH,
          GITHUB_WORKSPACE: workspace,
          GITHUB_OUTPUT: output,
          GITHUB_ENV: envFile,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      const outputs = Object.fromEntries(
        read(output)
          .trim()
          .split("\n")
          .map((line) => {
            const separator = line.indexOf("=");
            return [line.slice(0, separator), line.slice(separator + 1)];
          }),
      );
      cachePaths.push(
        restore.with.path.replace(
          /\$\{\{ steps\.pnpm-store\.outputs\.([^ ]+) \}\}/g,
          (_: string, name: string) => expectDefined(outputs[name], "store cache path"),
        ),
      );
      expect(read(envFile)).toContain(
        "PNPM_CONFIG_STORE_DIR=" + join(workspace, ".cache/openclaw-pnpm-store") + "\n",
      );
    }
    // Actions versions caches by the literal path input as well as the key.
    expect(cachePaths[1]).toBe(cachePaths[0]);
    const cachePath = cachePaths[0]!;
    const publisher = parse(read(".github/workflows/vitest-cache-warm.yml"));
    const save = publisher.jobs.dependencies.steps.find(
      (step: { name: string }) => step.name === "Save pnpm store cache",
    );
    const setup = parse(read(".github/actions/setup-node-env/action.yml"));
    expect(save.with.path).toBe("${{ steps.setup-node-env.outputs.pnpm-store-cache-path }}");
    expect(setup.outputs["pnpm-store-cache-path"].value).toBe(
      "${{ steps.setup-pnpm.outputs.store-cache-path }}",
    );
    expect(action.outputs["store-cache-path"].value).toBe(restore.with.path);
    const entry = join(workspaces[0]!, cachePath, "entry");
    fs.writeFileSync(entry, "cached package bytes\n");
    const archive = join(root, "store.tar");
    const pack = await command.run("tar", ["-cf", archive, "-C", workspaces[0]!, cachePath]);
    expect(pack.status, pack.stderr).toBe(0);
    const unpack = await command.run("tar", ["-xf", archive, "-C", workspaces[1]!]);
    expect(unpack.status, unpack.stderr).toBe(0);
    expect(read(join(workspaces[1]!, ".cache/openclaw-pnpm-store/entry"))).toBe(
      "cached package bytes\n",
    );
  });

  it.for([false, true])(
    "restores the store root before pnpm runs (configured: %s)",
    async (configured, { command }) => {
      const root = command.createTempDir("pnpm-store-root-");
      const output = join(root, "outputs");
      const envFile = join(root, "env");
      const store = join(root, configured ? "custom-store" : ".cache/openclaw-pnpm-store");
      const steps = action.runs.steps as Array<{ name: string; run: string }>;
      const resolve = steps.findIndex((step) => step.name === "Resolve pnpm store path");
      const restore = steps.findIndex((step) => step.name === "Restore pnpm store cache");
      const bootstrap = steps.findIndex((step) => step.name === "Setup pnpm from packageManager");
      expect(resolve).toBeLessThan(restore);
      expect(restore).toBeLessThan(bootstrap);
      const run = expectDefined(steps[resolve], "Resolve pnpm store path").run;
      const result = await command.run("bash", ["-eu", "-c", `pnpm() { return 99; }\n${run}`], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          GITHUB_WORKSPACE: root,
          GITHUB_OUTPUT: output,
          GITHUB_ENV: envFile,
          ...(configured ? { PNPM_CONFIG_STORE_DIR: store } : {}),
        },
      });
      expect(result.error, "pnpm store action subprocess").toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(read(output)).toBe(`path=${store}\ncache-path=${relative(root, store)}\n`);
      expect(read(envFile)).toBe(
        `PNPM_CONFIG_STORE_DIR=${store}\nPNPM_CONFIG_CACHE_DIR=${store}/cache\n`,
      );
    },
  );

  it.for([0, 42])("preserves the version probe exit status %s", async (status, { command }) => {
    const root = command.createTempDir("pnpm-version-step-");
    const output = join(root, "outputs");
    fs.writeFileSync(output, "");
    const step = action.runs.steps.find((entry: { id?: string }) => entry.id === "pnpm-version");
    const calls = join(root, "pnpm-calls");
    const pnpm = `pnpm() { echo called >> "$PNPM_CALLS"; if [ ${status} -eq 0 ]; then printf '12.9.0\\n'; else return ${status}; fi; }`;
    const run = `${pnpm}\n${step.run}`;
    const result = await command.run(
      "bash",
      ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", run],
      {
        encoding: "utf8",
        cwd: root,
        env: {
          PATH: process.env.PATH,
          PROJECT_DIR: root,
          GITHUB_OUTPUT: output,
          PNPM_CALLS: calls,
        },
      },
    );
    expect(result.error, "pnpm version action subprocess").toBeUndefined();
    expect(result.status, result.stderr).toBe(status);
    expect(read(output)).toBe(status === 0 ? "pnpm-version=12.9.0\n" : "");
    if (status === 0) {
      const nodeAction = parse(read(".github/actions/setup-node-env/action.yml"));
      const diagnostic = nodeAction.runs.steps.find(
        (entry: { name?: string }) => entry.name === "Runtime versions",
      );
      const outputs = Object.fromEntries(
        read(output)
          .trim()
          .split("\n")
          .map((line) => line.split("=")),
      );
      const env = Object.fromEntries(
        Object.entries(diagnostic.env ?? {}).map(([key, expression]) => [
          key,
          String(expression).replace(
            /\$\{\{ steps\.setup-pnpm\.outputs\.([^ ]+) \}\}/g,
            (_, name) => expectDefined(outputs[name], `recorded pnpm output ${name}`),
          ),
        ]),
      );
      const versions = await command.run(
        "bash",
        [
          "--noprofile",
          "--norc",
          "-e",
          "-o",
          "pipefail",
          "-c",
          `${pnpm}\nnode() { echo fixture-node; }\nnpm() { echo fixture-npm; }\nbun() { echo fixture-bun; }\n${diagnostic.run}`,
        ],
        { encoding: "utf8", cwd: root, env: { PATH: process.env.PATH, PNPM_CALLS: calls, ...env } },
      );
      expect(versions.status, versions.stderr).toBe(0);
      expect(versions.stdout).toBe("fixture-node\nfixture-npm\n12.9.0\nfixture-bun\n");
    }
    expect(read(calls)).toBe("called\n");
  });
});
