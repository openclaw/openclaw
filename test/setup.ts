import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function sanitizeWindowsCIOutput(text: string): string {
  return text
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "?")
    .replace(/[\uD800-\uDFFF]/g, "?");
}

if (process.platform === "win32" && process.env.GITHUB_ACTIONS === "true") {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = ((chunk: unknown, ...args: unknown[]) => {
    if (typeof chunk === "string") {
      return originalStdoutWrite(sanitizeWindowsCIOutput(chunk), ...args);
    }
    if (Buffer.isBuffer(chunk)) {
      return originalStdoutWrite(
        sanitizeWindowsCIOutput(chunk.toString("utf-8")),
        ...args,
      );
    }
    return originalStdoutWrite(chunk as never, ...args);
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: unknown, ...args: unknown[]) => {
    if (typeof chunk === "string") {
      return originalStderrWrite(sanitizeWindowsCIOutput(chunk), ...args);
    }
    if (Buffer.isBuffer(chunk)) {
      return originalStderrWrite(
        sanitizeWindowsCIOutput(chunk.toString("utf-8")),
        ...args,
      );
    }
    return originalStderrWrite(chunk as never, ...args);
  }) as typeof process.stderr.write;
}

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalXdgStateHome = process.env.XDG_STATE_HOME;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalTestHome = process.env.CLAWDBOT_TEST_HOME;

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-test-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.CLAWDBOT_TEST_HOME = tempHome;
process.env.XDG_CONFIG_HOME = path.join(tempHome, ".config");
process.env.XDG_DATA_HOME = path.join(tempHome, ".local", "share");
process.env.XDG_STATE_HOME = path.join(tempHome, ".local", "state");
process.env.XDG_CACHE_HOME = path.join(tempHome, ".cache");

const restoreEnv = (key: string, value: string | undefined) => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

process.on("exit", () => {
  restoreEnv("HOME", originalHome);
  restoreEnv("USERPROFILE", originalUserProfile);
  restoreEnv("XDG_CONFIG_HOME", originalXdgConfigHome);
  restoreEnv("XDG_DATA_HOME", originalXdgDataHome);
  restoreEnv("XDG_STATE_HOME", originalXdgStateHome);
  restoreEnv("XDG_CACHE_HOME", originalXdgCacheHome);
  restoreEnv("CLAWDBOT_TEST_HOME", originalTestHome);
  try {
    fs.rmSync(tempHome, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});
