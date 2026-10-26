import fs from "node:fs";
import { createServer } from "node:http";
import { basename, join } from "node:path";
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

describe("pnpm version output owns its failure", () => {
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
      expect(read(output)).toBe(`path=${store}\n`);
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
    const run = `pnpm() { if [ ${status} -eq 0 ]; then printf '12.9.0\\n'; else return ${status}; fi; }\n${step.run}`;
    const result = await command.run(
      "bash",
      ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", run],
      {
        encoding: "utf8",
        cwd: root,
        env: { PATH: process.env.PATH, PROJECT_DIR: root, GITHUB_OUTPUT: output },
      },
    );
    expect(result.error, "pnpm version action subprocess").toBeUndefined();
    expect(result.status, result.stderr).toBe(status);
    expect(read(output)).toBe(status === 0 ? "pnpm-version=12.9.0\n" : "");
  });
});
