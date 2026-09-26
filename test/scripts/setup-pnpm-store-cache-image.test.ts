import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const source = readFileSync(
  ".github/actions/setup-pnpm-store-cache/seed-pnpm-from-image.mjs",
  "utf8",
);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function fixture(platform = "linux", version = "12.3.4") {
  const root = tempDirs.make("pnpm-image-");
  const image = join(root, "image");
  const runnerTemp = join(root, "runner");
  const stage = join(root, "stage");
  const storeDir = join(root, "store");
  for (const directory of [image, runnerTemp, stage, storeDir]) {
    mkdirSync(directory);
  }
  const store = realpathSync.native(storeDir);
  function archive(name: string) {
    writeFileSync(join(stage, "pnpm"), name);
    mkdirSync(join(stage, "bin"), { recursive: true });
    writeFileSync(join(stage, "bin", "pnpm.mjs"), `console.log(${JSON.stringify(version)});`);
    execFileSync("tar", ["-czf", join(image, name), "-C", root, "stage"]);
    return createHash("sha512")
      .update(readFileSync(join(image, name)))
      .digest("hex");
  }
  const wrapperHash = archive(`pnpm-${version}.tgz`);
  const nativeHash = archive(`exe.linux-x64-${version}.tgz`);
  // The fixture is a trusted script with synthetic anchors, not a candidate-supplied pin.
  const script = source
    .replaceAll("/opt/crabbox/toolchain-archives", image)
    .replaceAll("process.platform", JSON.stringify(platform))
    .replaceAll("process.arch", '"x64"')
    .replace(
      version === "12.4.2"
        ? "08adc6613180275c7c9edada39dcf08c9c61ad4e7eaf330a4f3461f102b0f907423454d117f98e72d47fef0616070644d7bffc973a6a57f5090a6d7c368b07c9"
        : "961aa41fb077da3a04a441d9f8e15ebc0c96da8ef710b2eb67bf9ee7cb0610eabd48f1fd85f51cffe73846785fa0f87c56a3a872a1d893f8446741b5cce45457",
      wrapperHash,
    )
    .replace(
      "d99a8e9523e47f05f5879711f853e259ff3e17eda1653ff74ef8542b9b22807ab06900888aaf11ec21b186774ab3adc9b5c2e2d9ad50a68fb05ff128c9f8f225",
      nativeHash,
    );
  const scriptPath = join(root, "seed.mjs");
  writeFileSync(scriptPath, script);
  const spec = `pnpm@${version}+sha512.${wrapperHash}`;
  return {
    root,
    image,
    runnerTemp,
    spec,
    run(packageManager = spec) {
      return spawnSync(process.execPath, [scriptPath, packageManager], {
        encoding: "utf8",
        env: {
          ...process.env,
          RUNNER_TEMP: runnerTemp,
          COREPACK_HOME: join(root, "old-corepack"),
          PNPM_CONFIG_STORE_DIR: store,
          COREPACK_ENABLE_NETWORK: "0",
        },
      });
    },
  };
}

describe("pnpm image archive consumer", () => {
  it("seeds the pinned Windows wrapper without installing a Linux native binary", () => {
    const f = fixture("win32", "12.4.2");
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).not.toBe("");
    const pnpmRoot = join(result.stdout.trim(), "v1", "pnpm", "12.4.2");
    const metadata = JSON.parse(readFileSync(join(pnpmRoot, ".corepack"), "utf8"));
    expect(metadata.hash).toBe(f.spec.slice(f.spec.indexOf("+") + 1));
    expect(metadata.bin.pnpm).toBe("./bin/pnpm.mjs");
    expect(existsSync(join(pnpmRoot, "node_modules"))).toBe(false);
    expect(
      execFileSync(process.execPath, [join(pnpmRoot, metadata.bin.pnpm)], {
        encoding: "utf8",
      }).trim(),
    ).toBe("12.4.2");
    expect(existsSync(join(f.root, "old-corepack"))).toBe(false);
  });

  it("does not admit a corrupt Windows wrapper with networking disabled", () => {
    const f = fixture("win32", "12.4.2");
    writeFileSync(join(f.image, "pnpm-12.4.2.tgz"), "corrupt wrapper");
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(readdirSync(f.runnerTemp)).toEqual([]);
  });

  it("seeds each job from verified archives into independent private Corepack state", () => {
    const f = fixture();
    const homes: string[] = [];
    for (let run = 0; run < 2; run++) {
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
      const home = result.stdout.trim();
      homes.push(home);
      const pnpmRoot = join(home, "v1", "pnpm", "12.3.4");
      expect(readFileSync(join(pnpmRoot, "pnpm"), "utf8")).toBe("pnpm-12.3.4.tgz");
      expect(
        readFileSync(join(pnpmRoot, "node_modules", "@pnpm", "exe.linux-x64", "pnpm"), "utf8"),
      ).toBe("exe.linux-x64-12.3.4.tgz");
      const metadata = JSON.parse(readFileSync(join(pnpmRoot, ".corepack"), "utf8"));
      expect(metadata.hash).toBe(f.spec.slice(f.spec.indexOf("+") + 1));
      expect(metadata.bin.pnpm).toBe("./bin/pnpm.mjs");
      writeFileSync(join(pnpmRoot, "pnpm"), "tampered extracted executable");
    }
    expect(homes[0]).not.toBe(homes[1]);
    expect(existsSync(join(f.root, "old-corepack"))).toBe(false);
    expect(readdirSync(f.runnerTemp)).toHaveLength(2);
  });

  it.each(["pnpm-12.3.4.tgz", "exe.linux-x64-12.3.4.tgz"])(
    "delegates substituted %s to Corepack with an empty store, ignoring adjacent trust markers",
    (name) => {
      const f = fixture();
      writeFileSync(join(f.image, name), "bad archive");
      writeFileSync(join(f.image, ".complete"), "");
      writeFileSync(
        join(f.image, `${name}.sha512`),
        createHash("sha512").update("bad archive").digest("hex"),
      );
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("");
      expect(readdirSync(f.runnerTemp)).toEqual([]);
    },
  );

  it.each(["missing", "different-version", "different-hash"])(
    "leaves ordinary Corepack registry preparation in control with an empty store on %s",
    (kind) => {
      const f = fixture();
      if (kind === "missing") {
        rmSync(join(f.image, "pnpm-12.3.4.tgz"));
      }
      const spec =
        kind === "different-version"
          ? f.spec.replace("12.3.4", "12.3.5")
          : kind === "different-hash"
            ? f.spec.replace(/.$/u, "z")
            : f.spec;
      const result = f.run(spec);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("");
      expect(readdirSync(f.runnerTemp)).toEqual([]);
    },
  );

  it.each(["missing", "corrupt"])(
    "uses authenticated store archives when the image is %s",
    (kind) => {
      const f = fixture();
      const seeded = f.run();
      expect(seeded.status, seeded.stderr).toBe(0);
      rmSync(seeded.stdout.trim(), { recursive: true });
      for (const name of ["pnpm-12.3.4.tgz", "exe.linux-x64-12.3.4.tgz"]) {
        if (kind === "missing") {
          rmSync(join(f.image, name));
        } else {
          writeFileSync(join(f.image, name), "substituted image archive");
        }
      }
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
      const pnpmRoot = join(result.stdout.trim(), "v1", "pnpm", "12.3.4");
      expect(readFileSync(join(pnpmRoot, "pnpm"), "utf8")).toBe("pnpm-12.3.4.tgz");
      expect(readFileSync(join(pnpmRoot, "node_modules/@pnpm/exe.linux-x64/pnpm"), "utf8")).toBe(
        "exe.linux-x64-12.3.4.tgz",
      );
      expect(JSON.parse(readFileSync(join(pnpmRoot, ".corepack"), "utf8")).hash).toBe(
        f.spec.slice(f.spec.indexOf("+") + 1),
      );
    },
  );

  it("wires image seeding before preparation without changing dependency installation", () => {
    const action = parse(readFileSync(".github/actions/setup-pnpm-store-cache/action.yml", "utf8"));
    const workflow = parse(readFileSync(".github/workflows/crabbox-hydrate.yml", "utf8"));
    for (const steps of [action.runs.steps, workflow.jobs.hydrate.steps]) {
      const preparation = steps.find((step: { run?: string }) =>
        step.run?.includes("corepack prepare"),
      );
      expect(preparation.run.indexOf("seed-pnpm-from-image.mjs")).toBeLessThan(
        preparation.run.indexOf("corepack prepare"),
      );
      expect(preparation.run).toContain('echo "COREPACK_HOME=$COREPACK_HOME" >> "$GITHUB_ENV"');
    }
    const hydration = workflow.jobs.hydrate.steps;
    expect(hydration.find((step: { name: string }) => step.name === "Setup Node.js").run).toContain(
      'openclaw_ensure_node "24.x"',
    );
    expect(
      hydration.find((step: { run?: string }) => step.run?.includes("install_args=")).run,
    ).toContain("--frozen-lockfile");
  });

  it.each([
    ["hydrate", true],
    ["hydrate", false],
    ["hydrate-github", true],
    ["hydrate-github", false],
  ] as const)("restores %s Corepack state in a fresh shell (configured=%s)", (job, configured) => {
    const workflow = parse(readFileSync(".github/workflows/crabbox-hydrate.yml", "utf8"));
    const ready = workflow.jobs[job].steps.find(
      (step: { name?: string }) => step.name === "Mark Crabbox ready",
    );
    const home = tempDirs.make("crabbox-session-");
    const corepackHome = join(
      home,
      "corepack cache ' \" $HOME $(touch injected) `touch injected` ;",
    );
    mkdirSync(corepackHome);
    writeFileSync(join(corepackHome, "ready.txt"), "prepared cache fixture\n");
    const env = {
      HOME: home,
      PATH: "/usr/bin:/bin",
      CRABBOX_ID: "image-cache",
      CRABBOX_JOB: job,
      GITHUB_WORKSPACE: home,
      GITHUB_RUN_ID: "123",
    };
    const marked = spawnSync(
      "/bin/bash",
      ["--noprofile", "--norc", "-c", `docker() { :; }\n${ready.run}`],
      {
        cwd: home,
        encoding: "utf8",
        env: { ...env, ...(configured ? { COREPACK_HOME: corepackHome } : {}) },
      },
    );
    expect(marked.status, marked.stderr).toBe(0);
    const restored = spawnSync(
      "/bin/bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        `set -euo pipefail
source "$1"
if [ "\${COREPACK_HOME+x}" = x ]; then
  printf '%s\\n' "$COREPACK_HOME"
  cat "$COREPACK_HOME/ready.txt"
else
  printf 'unset\\n'
fi`,
        "saved-session",
        join(home, ".crabbox", "actions", "image-cache.env.sh"),
      ],
      { cwd: home, encoding: "utf8", env },
    );
    expect(restored.status, restored.stderr).toBe(0);
    expect(restored.stdout).toBe(
      configured ? `${corepackHome}\nprepared cache fixture\n` : "unset\n",
    );
    expect(existsSync(join(home, "injected"))).toBe(false);
  });
});
