import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const tempDirs = new Set<string>();
const sentinel = "fal-sentinel-not-a-real-key-0123456789";
const quotedSentinel = "synthetic value with a 'quote'";
const script = join(process.cwd(), "scripts/crabbox-remote-redact.mjs");

afterEach(() => cleanupTempDirs(tempDirs));

function fixture(profile?: string) {
  const home = makeTempDir(tempDirs, "crabbox-remote-redact-");
  if (profile !== undefined) {
    writeFileSync(join(home, ".openclaw-testbox-live.profile"), profile);
  }
  return {
    home,
    run: (code: string, env: NodeJS.ProcessEnv = {}) => {
      return spawnSync(process.execPath, [script, "--", process.execPath, "-e", code], {
        env: { PATH: process.env.PATH, HOME: home, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
    },
  };
}

describe("crabbox remote stream redaction", () => {
  it("redacts profile values across writes without putting them in the child env", () => {
    const { run } = fixture(
      `export FAL_KEY='${sentinel}'\nexport QUOTED_KEY='synthetic value with a '\\''quote'\\'''\n`,
    );
    const half = Math.floor(sentinel.length / 2);
    const prefixLength = 64 * 1024 - half;
    const result = run(`
      const fs = require('node:fs');
      const secret = ${JSON.stringify(sentinel)};
      fs.writeSync(1, 'FAL_KEY=' + secret + '\\n');
      fs.writeSync(1, 'x'.repeat(${prefixLength}) + secret.slice(0, ${half}));
      fs.writeSync(1, secret.slice(${half}) + '\\n');
      fs.writeSync(2, ${JSON.stringify(quotedSentinel)} + '\\n');
      fs.writeSync(1, 'child_has_key=' + Object.hasOwn(process.env, 'FAL_KEY') + '\\n');
      fs.writeSync(2, Buffer.from([0xff, 0x80, 0x00, 0xfe, 0x0a]));
    `);

    expect(result.status).toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.stdout.toString()).toBe(
      `FAL_KEY=<redacted len=${sentinel.length}>\n${"x".repeat(prefixLength)}<redacted len=${sentinel.length}>\nchild_has_key=false\n`,
    );
    expect(result.stderr).toEqual(
      Buffer.concat([
        Buffer.from(`<redacted len=${quotedSentinel.length}>\n`),
        Buffer.from([0xff, 0x80, 0x00, 0xfe, 0x0a]),
      ]),
    );
  });

  it("flushes redacted partial lines and preserves the child's exit code", () => {
    const { run } = fixture(`export FAL_KEY='${sentinel}'\n`);
    const result = run(`process.stdout.write(${JSON.stringify(sentinel)}); process.exitCode = 7;`);

    expect(result.status).toBe(7);
    expect(result.stdout.toString()).toBe(`<redacted len=${sentinel.length}>`);
    expect(result.stderr.length).toBe(0);
  });

  it.each([undefined, "export FAL_KEY=short\n"])(
    "passes bytes through unchanged when no registry-length values are available (%s)",
    (profile) => {
      const { run } = fixture(profile);
      const bytes = [0xff, 0x80, 0x00, 0xfe, 0x0a];
      const result = run(`
        process.stdout.write(Buffer.from(${JSON.stringify(bytes)}));
        process.stderr.write(${JSON.stringify(sentinel)});
      `);

      expect(result.status).toBe(0);
      expect(result.stdout).toEqual(Buffer.from(bytes));
      expect(result.stderr.toString()).toBe(sentinel);
    },
  );

  it("reads the configured profile path", () => {
    const { home, run } = fixture();
    const profilePath = join(home, "custom profile");
    writeFileSync(profilePath, `export FAL_KEY='${sentinel}'\n`);
    const result = run(`process.stdout.write(${JSON.stringify(sentinel)});`, {
      OPENCLAW_TESTBOX_PROFILE_FILE: profilePath,
    });

    expect(result.status).toBe(0);
    expect(result.stdout.toString()).toBe(`<redacted len=${sentinel.length}>`);
  });
});
