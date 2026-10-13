// Linux OOM score tests cover best-effort process OOM score adjustment.
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  prepareOomScoreAdjustedSpawn,
  prepareOomScoreAdjustedSpawnPreservingExecEnv,
  spawnOomScoreAdjusted,
  type OomScoreAdjustedSpawn,
} from "./linux-oom-score.js";

const wrapScript = 'echo 1000 > /proc/self/oom_score_adj 2>/dev/null; exec "$0" "$@"';
const carriers = {
  BASH_ENV: "OC_INTERNAL_OOM_EXEC_BASH_ENV",
  ENV: "OC_INTERNAL_OOM_EXEC_ENV",
  CDPATH: "OC_INTERNAL_OOM_EXEC_CDPATH",
  PS4: "OC_INTERNAL_OOM_EXEC_PS4",
} as const;
const linux = { platform: "linux", env: {}, shellAvailable: () => true } as const;
const bashAvailable = fs.existsSync("/bin/bash");

function spawnPreparedWithBashAsSh(prepared: OomScoreAdjustedSpawn) {
  return spawnSync(prepared.wrapped ? "/bin/bash" : prepared.command, prepared.args, {
    ...(prepared.wrapped
      ? { argv0: "sh" }
      : prepared.argv0 === undefined
        ? {}
        : { argv0: prepared.argv0 }),
    env: prepared.env,
    encoding: "utf8",
  });
}

describe("prepareOomScoreAdjustedSpawn", () => {
  it("preserves the spawn shape when wrap does not apply", () => {
    const env = { PATH: "/usr/bin" };
    expect(
      prepareOomScoreAdjustedSpawn("/usr/bin/node", ["run.js"], {
        platform: "darwin",
        env,
        shellAvailable: () => true,
      }),
    ).toEqual({
      command: "/usr/bin/node",
      args: ["run.js"],
      env,
      wrapped: false,
    });
  });

  it("adjusts a distinct child argv0 without a shell", () => {
    const argv0 = "/opt/shims/claude";
    const options = { ...linux, argv0 };

    const prepared = prepareOomScoreAdjustedSpawn("/usr/bin/mise", ["-p"], {
      ...options,
      shellAvailable: () => false,
    });
    expect(prepared).toEqual({
      command: "/usr/bin/mise",
      args: ["-p"],
      argv0,
      env: {},
      wrapped: false,
      afterSpawn: expect.any(Function),
    });
    const write = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});
    try {
      prepared.afterSpawn?.(4321);
      expect(write).toHaveBeenCalledWith("/proc/4321/oom_score_adj", "1000");
    } finally {
      write.mockRestore();
    }
  });

  it.each([undefined, "/opt/shims/claude"])("respects the OOM opt-out with argv0 %s", (argv0) => {
    const prepared = prepareOomScoreAdjustedSpawn("/usr/bin/node", ["run.js"], {
      ...linux,
      argv0,
      env: { OPENCLAW_CHILD_OOM_SCORE_ADJ: "off" },
    });
    expect(prepared).toMatchObject({ command: "/usr/bin/node", args: ["run.js"], wrapped: false });
    expect(prepared).not.toHaveProperty("afterSpawn");
  });

  it("inherits the parent opt-out through sanitized child environments unless explicitly overridden", () => {
    vi.stubEnv("OPENCLAW_CHILD_OOM_SCORE_ADJ", "0");
    try {
      const options = { ...linux, argv0: "/opt/shims/claude" };
      expect(prepareOomScoreAdjustedSpawn("/usr/bin/node", [], options)).not.toHaveProperty(
        "afterSpawn",
      );
      expect(
        prepareOomScoreAdjustedSpawn("/usr/bin/node", [], {
          ...options,
          env: { OPENCLAW_CHILD_OOM_SCORE_ADJ: "1" },
        }),
      ).toHaveProperty("afterSpawn");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not double-wrap an adjusted command", () => {
    expect(
      prepareOomScoreAdjustedSpawn("/bin/sh", ["-c", wrapScript, "/usr/bin/node", "run.js"], {
        ...linux,
        env: {
          PATH: "/usr/bin",
          BASH_ENV: "/tmp/bashenv",
          ENV: "/tmp/env",
          CDPATH: "/tmp",
          SHELLOPTS: "xtrace",
          BASHOPTS: "extdebug",
          PS4: "trace",
          "BASH_FUNC_echo%%": "() { :; }",
        },
      }),
    ).toEqual({
      command: "/bin/sh",
      args: ["-c", wrapScript, "/usr/bin/node", "run.js"],
      env: { PATH: "/usr/bin" },
      wrapped: true,
    });
  });

  it("does not pass command names that look like shell options to exec", () => {
    expect(prepareOomScoreAdjustedSpawn("-p", ["node"], linux)).toMatchObject({
      command: "-p",
      args: ["node"],
      wrapped: false,
    });
  });
});

it("preserves native ENOENT for missing plugin commands", async () => {
  const child = spawnOomScoreAdjusted("/openclaw-nonexistent-oom-test-command", [], {
    stdio: "ignore",
  });
  await expect(once(child, "spawn")).rejects.toMatchObject({ code: "ENOENT" });
});

it.runIf(process.platform === "linux").each([undefined, "/opt/shims/claude"])(
  "sets the child OOM score while preserving argv0 %s and the parent score",
  async (argv0) => {
    const parentScore = fs.readFileSync("/proc/self/oom_score_adj", "utf8");
    const child = spawnOomScoreAdjusted(
      process.execPath,
      [
        "-e",
        'process.stdin.once("data", () => process.stdout.end(JSON.stringify({ argv0: process.argv0, score: require("node:fs").readFileSync("/proc/self/oom_score_adj", "utf8").trim() })))',
      ],
      { argv0, env: { ...process.env, OPENCLAW_CHILD_OOM_SCORE_ADJ: "1" }, stdio: "pipe" },
    );
    const closed = once(child, "close");
    try {
      await once(child, "spawn");
      let output = "";
      child.stdout!.on("data", (chunk) => {
        output += chunk;
      });
      child.stdin!.end("ready");
      const result = await closed;
      expect(result).toEqual([0, null]);
      expect(JSON.parse(output)).toEqual({ argv0: argv0 ?? process.execPath, score: "1000" });
      expect(fs.readFileSync("/proc/self/oom_score_adj", "utf8")).toBe(parentScore);
    } finally {
      child.kill("SIGKILL");
      await closed;
    }
  },
);

describe("prepareOomScoreAdjustedSpawnPreservingExecEnv", () => {
  it("falls back to direct spawn on a defined carrier collision", () => {
    const env = {
      PATH: "/usr/bin",
      BASH_ENV: "/tmp/bashenv",
      [carriers.ENV]: "reserved",
    };
    const result = prepareOomScoreAdjustedSpawnPreservingExecEnv("/usr/bin/node", ["run.js"], {
      ...linux,
      env,
    });

    expect(result).toEqual({
      command: "/usr/bin/node",
      args: ["run.js"],
      env,
      wrapped: false,
    });
    expect(result.env).toBe(env);
  });

  it.runIf(process.platform !== "win32")(
    "restores exact values only for the final executable",
    () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-oom-env-"));
      const bashEnvPath = path.join(tempDir, "bash-env.sh");
      const startupMarkerPath = path.join(tempDir, "wrapper-startup-marker");
      fs.writeFileSync(bashEnvPath, `printf touched > "${startupMarkerPath}"\n`);
      try {
        const prepared = prepareOomScoreAdjustedSpawnPreservingExecEnv(
          process.execPath,
          [
            "-e",
            `process.stdout.write(JSON.stringify({bashEnv:process.env.BASH_ENV,envPresent:Object.hasOwn(process.env,"ENV"),env:process.env.ENV,cdpath:process.env.CDPATH,ps4:process.env.PS4,carrierKeys:Object.keys(process.env).filter(key=>key.startsWith("OC_INTERNAL_OOM_EXEC_"))}))`,
          ],
          {
            ...linux,
            env: {
              PATH: process.env.PATH,
              BASH_ENV: bashEnvPath,
              ENV: "",
              CDPATH: "line1\nline2",
              PS4: "final-trace-prefix",
            },
          },
        );
        const child = spawnSync(prepared.command, prepared.args, {
          env: prepared.env,
          encoding: "utf8",
        });

        expect(child.status).toBe(0);
        expect(JSON.parse(child.stdout)).toEqual({
          bashEnv: bashEnvPath,
          envPresent: true,
          env: "",
          cdpath: "line1\nline2",
          ps4: "final-trace-prefix",
          carrierKeys: [],
        });
        expect(fs.existsSync(startupMarkerPath)).toBe(false);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it.runIf(bashAvailable)(
    "does not expose preserving carriers to Bash-as-sh xtrace startup",
    () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-oom-xtrace-"));
      const markerPath = path.join(tempDir, "ps4-marker");
      const secret = "review-secret-carried-value";
      try {
        const env = {
          PATH: process.env.PATH,
          BASH_ENV: secret,
          SHELLOPTS: "braceexpand:hashall:interactive-comments:xtrace",
          PS4: `$(printf touched > "${markerPath}")trace `,
        };
        const prepared = prepareOomScoreAdjustedSpawnPreservingExecEnv(
          process.execPath,
          ["-e", ""],
          { ...linux, env },
        );
        const child = spawnPreparedWithBashAsSh(prepared);

        expect(child.status).toBe(0);
        expect(fs.existsSync(markerPath)).toBe(false);
        expect(child.stderr).not.toContain(secret);
        expect(child.stderr).not.toContain(carriers.BASH_ENV);
        expect(prepared.wrapped).toBe(false);
        expect(prepared.env).toBe(env);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it.runIf(bashAvailable)("strips xtrace startup controls from Bash-as-sh", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-oom-strip-xtrace-"));
    const markerPath = path.join(tempDir, "ps4-marker");
    try {
      const prepared = prepareOomScoreAdjustedSpawn(process.execPath, ["-e", ""], {
        ...linux,
        env: {
          PATH: process.env.PATH,
          SHELLOPTS: "braceexpand:hashall:interactive-comments:xtrace",
          PS4: `$(printf touched > "${markerPath}")trace `,
        },
      });
      const child = spawnPreparedWithBashAsSh(prepared);

      expect(child.status).toBe(0);
      expect(fs.existsSync(markerPath)).toBe(false);
      expect(prepared.wrapped).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "linux" && bashAvailable)(
    "blocks imported Bash functions from overriding wrapper commands",
    () => {
      for (const [prepare, expectedWrapped] of [
        [prepareOomScoreAdjustedSpawnPreservingExecEnv, false],
        [prepareOomScoreAdjustedSpawn, true],
      ] as const) {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-oom-function-"));
        const markerPath = path.join(tempDir, "echo-marker");
        try {
          const prepared = prepare(process.execPath, ["-e", ""], {
            ...linux,
            env: {
              PATH: process.env.PATH,
              "BASH_FUNC_echo%%": `() { printf touched > "${markerPath}"; builtin echo "$@"; }`,
            },
          });
          const child = spawnPreparedWithBashAsSh(prepared);

          expect(child.status).toBe(0);
          expect(fs.existsSync(markerPath)).toBe(false);
          expect(prepared.wrapped).toBe(expectedWrapped);
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }
    },
  );
});
