import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect } from "vitest";
import { parse } from "yaml";
import { createCommandTest } from "../helpers/command-fixture.js";
import { createPnpmArchiveFixture } from "./setup-pnpm-archive.test-support.js";

const it = createCommandTest();

describe("pinned pnpm cold bootstrap", () => {
  it.for([{ platform: "darwin" }, { arch: "riscv64" }, { glibc: false }])(
    "leaves unsupported native selection with its owner: %j",
    async (options, { command }) => {
      const f = createPnpmArchiveFixture(command, options);
      const result = await f.run();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("");
      expect(fs.existsSync(f.calls)).toBe(false);
    },
  );

  it("bootstraps from store, image, then registry while authenticating each archive", async ({
    command,
  }) => {
    const f = createPnpmArchiveFixture(command);
    const archives = fs.readdirSync(f.registry);
    for (const name of archives) {
      fs.copyFileSync(path.join(f.registry, name), path.join(f.image, name));
    }
    for (const source of ["image", "store", "registry"]) {
      if (source === "store") {
        for (const name of archives) {
          fs.writeFileSync(path.join(f.image, name), "corrupt image");
        }
      } else if (source === "registry") {
        for (const name of archives) {
          fs.writeFileSync(path.join(f.store, "toolchain", name), "corrupt store");
        }
      }
      const result = await f.run();
      expect(result.status, result.stderr).toBe(0);
      const root = path.join(result.stdout.trim(), "v1/pnpm/12.4.0");
      expect(fs.readFileSync(path.join(root, "pnpm"), "utf8")).toBe("wrapper-fixture\n");
      expect(
        fs.readFileSync(path.join(root, "node_modules/@pnpm/exe.linux-x64/pnpm"), "utf8"),
      ).toBe("native-fixture\n");
      expect(JSON.parse(fs.readFileSync(path.join(root, ".corepack"), "utf8")).hash).toBe(
        f.spec.split("+")[1],
      );
      expect(fs.existsSync(f.calls)).toBe(source === "registry");
      for (const name of archives) {
        expect(fs.readFileSync(path.join(f.store, "toolchain", name))).toEqual(
          fs.readFileSync(path.join(f.registry, name)),
        );
      }
    }
    expect(fs.readFileSync(f.calls, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("stops on a download error without retrying or publishing cache state", async ({
    command,
  }) => {
    const f = createPnpmArchiveFixture(command);
    const result = await f.run({ CURL_FIXTURE_EXIT: "22" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Cannot download pinned pnpm archive");
    expect(result.stdout).toBe("");
    expect(fs.readFileSync(f.calls, "utf8").trim().split("\n")).toHaveLength(1);
    expect(fs.readdirSync(f.runner)).toEqual([]);
  });

  it("downloads authenticated registry archives when both the store and image are empty", async ({
    command,
  }) => {
    const f = createPnpmArchiveFixture(command);
    const result = await f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).not.toBe("");
    const root = path.join(result.stdout.trim(), "v1/pnpm/12.4.0");
    expect(fs.readFileSync(path.join(root, "pnpm"), "utf8")).toBe("wrapper-fixture\n");
    expect(fs.readFileSync(path.join(root, "node_modules/@pnpm/exe.linux-x64/pnpm"), "utf8")).toBe(
      "native-fixture\n",
    );
    expect(JSON.parse(fs.readFileSync(path.join(root, ".corepack"), "utf8"))).toEqual({
      locator: { name: "pnpm", reference: f.spec.slice(5) },
      bin: { pnpm: "./bin/pnpm.mjs", pnpx: "./bin/pnpx.mjs" },
      hash: f.spec.split("+")[1],
    });
    expect(fs.readFileSync(f.calls, "utf8").trim().split("\n")).toHaveLength(2);
    expect(fs.readdirSync(f.runner)).toHaveLength(1);
  });

  it("uses authenticated image bytes without making a network request", async ({ command }) => {
    const f = createPnpmArchiveFixture(command);
    for (const name of fs.readdirSync(f.registry)) {
      fs.copyFileSync(path.join(f.registry, name), path.join(f.image, name));
    }
    const result = await f.run({ COREPACK_ENABLE_NETWORK: "0" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).not.toBe("");
    expect(fs.existsSync(f.calls)).toBe(false);
  });

  it("bootstraps from the warmed store while archive downloads are unavailable", async ({
    command,
  }) => {
    const f = createPnpmArchiveFixture(command);
    const cold = await f.run();
    expect(cold.status, cold.stderr).toBe(0);
    fs.unlinkSync(f.calls);
    fs.rmSync(cold.stdout.trim(), { recursive: true });
    const warm = await f.run({ CURL_FIXTURE_EXIT: "35", COREPACK_ENABLE_NETWORK: "0" });
    expect(warm.status, warm.stderr).toBe(0);
    expect(warm.stdout.trim()).not.toBe("");
    expect(fs.existsSync(f.calls)).toBe(false);
    expect(fs.readFileSync(path.join(warm.stdout.trim(), "v1/pnpm/12.4.0/pnpm"), "utf8")).toBe(
      "wrapper-fixture\n",
    );
  });

  it.for([
    { name: "pnpm-12.4.0.tgz", fallback: "registry" },
    { name: "exe.linux-x64-12.4.0.tgz", fallback: "registry" },
    { name: "pnpm-12.4.0.tgz", fallback: "image" },
    { name: "exe.linux-x64-12.4.0.tgz", fallback: "image" },
  ])(
    "repairs unauthenticated cached $name through the $fallback",
    async ({ name, fallback }, { command }) => {
      const f = createPnpmArchiveFixture(command);
      const cold = await f.run();
      expect(cold.status, cold.stderr).toBe(0);
      fs.unlinkSync(f.calls);
      fs.writeFileSync(path.join(f.store, "toolchain", name), "substituted bytes");
      if (fallback === "image") {
        for (const archive of fs.readdirSync(f.registry)) {
          fs.copyFileSync(path.join(f.registry, archive), path.join(f.image, archive));
        }
      }
      const repaired = await f.run();
      expect(repaired.status, repaired.stderr).toBe(0);
      const calls = fs.existsSync(f.calls)
        ? fs.readFileSync(f.calls, "utf8").trim().split("\n")
        : [];
      expect(calls).toHaveLength(fallback === "registry" ? 1 : 0);
      expect(fs.readFileSync(path.join(f.store, "toolchain", name))).toEqual(
        fs.readFileSync(path.join(f.registry, name)),
      );
    },
  );

  it.for(["pnpm-12.4.0.tgz", "exe.linux-x64-12.4.0.tgz"])(
    "rejects substituted downloaded %s and removes incomplete state",
    async (name, { command }) => {
      const f = createPnpmArchiveFixture(command);
      fs.writeFileSync(path.join(f.registry, name), "substituted bytes");
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
  ])(
    "retains ordinary owner policy when cold network seeding is unavailable: %j",
    async (env, { command }) => {
      const f = createPnpmArchiveFixture(command);
      const result = await f.run(env);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("");
      expect(fs.existsSync(f.calls)).toBe(false);
      expect(fs.readdirSync(f.runner)).toEqual([]);
    },
  );

  it("does not fetch an unrecognized version or changed packageManager integrity", async ({
    command,
  }) => {
    const f = createPnpmArchiveFixture(command);
    for (const spec of [f.spec.replace("12.4.0", "12.4.1"), f.spec.replace(/.$/u, "z")]) {
      const result = await f.run({}, spec);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    }
    expect(fs.existsSync(f.calls)).toBe(false);
  });
});

describe("pnpm version output owns its failure", () => {
  it.for([false, true])(
    "restores the store root before pnpm runs (configured: %s)",
    async (configured, { command }) => {
      const root = command.createTempDir("pnpm-store-root-");
      const output = path.join(root, "outputs");
      const envFile = path.join(root, "env");
      const store = path.join(root, configured ? "custom-store" : ".cache/openclaw-pnpm-store");
      const action = parse(
        fs.readFileSync(".github/actions/setup-pnpm-store-cache/action.yml", "utf8"),
      );
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
      expect(fs.readFileSync(output, "utf8")).toBe(`path=${store}\n`);
      expect(fs.readFileSync(envFile, "utf8")).toBe(
        `PNPM_CONFIG_STORE_DIR=${store}\nPNPM_CONFIG_CACHE_DIR=${store}/cache\n`,
      );
    },
  );

  it.for([0, 42])("preserves the version probe exit status %s", async (status, { command }) => {
    const root = command.createTempDir("pnpm-version-step-");
    const output = path.join(root, "outputs");
    fs.writeFileSync(output, "");
    const action = parse(
      fs.readFileSync(".github/actions/setup-pnpm-store-cache/action.yml", "utf8"),
    );
    const step = action.runs.steps.find((entry: { id?: string }) => entry.id === "pnpm-version");
    const run = `pnpm() { if [ ${status} -eq 0 ]; then printf '12.4.0\\n'; else return ${status}; fi; }\n${step.run}`;
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
    expect(fs.readFileSync(output, "utf8")).toBe(status === 0 ? "pnpm-version=12.4.0\n" : "");
  });
});
