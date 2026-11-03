import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  loadGlobalRuntimeDotEnvFilesAsyncCore,
  loadGlobalRuntimeDotEnvFilesCore,
} from "./dotenv-global-core.js";
import { readDotEnvFile } from "./dotenv-global.js";
import { fsSafeEnvInput } from "./fs-safe-env.js";

const logWarnSpy = vi.hoisted(() => vi.fn());

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: logWarnSpy }),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => logWarnSpy.mockClear());
const tmpDir = () => tempDirs.make("openclaw-dotenv-global-");

function tmpFile(name: string, contents: string | Buffer): string {
  const p = join(tmpDir(), name);
  writeFileSync(p, contents, "utf8");
  return p;
}

it.each(["direct", "symlink"])("reads a %s .env file", (kind) => {
  const realPath = tmpFile("real.env", "API_KEY=secret\nOTHER_KEY=value\n");
  const filePath = kind === "direct" ? realPath : join(tmpDir(), ".env");
  if (kind === "symlink") {
    symlinkSync(realPath, filePath);
  }
  expect(readDotEnvFile({ filePath })?.entries).toEqual(
    expect.arrayContaining([
      { key: "API_KEY", value: "secret" },
      { key: "OTHER_KEY", value: "value" },
    ]),
  );
  expect(logWarnSpy).not.toHaveBeenCalled();
});

it("returns null for a missing file", () => {
  expect(readDotEnvFile({ filePath: join(tmpDir(), "missing.env") })).toBeNull();
  expect(logWarnSpy).not.toHaveBeenCalled();
});

it("skips an oversized .env file", () => {
  const large = Buffer.alloc(2 * 1024 * 1024, "x");
  large.write("KEY=value\n", 0, "utf8");
  expect(readDotEnvFile({ filePath: tmpFile("large.env", large) })).toBeNull();
});

it.each([
  { name: "sync", load: loadGlobalRuntimeDotEnvFilesCore },
  { name: "async", load: loadGlobalRuntimeDotEnvFilesAsyncCore },
])(
  "maps legacy modes from $name dotenv loads without blocking a later native setting",
  async ({ load }) => {
    const home = tmpDir();
    const stateEnvPath = join(home, "runtime.env");
    const env: NodeJS.ProcessEnv = { HOME: home, OPENCLAW_STATE_DIR: home };
    const apply = (contents: string) => {
      writeFileSync(stateEnvPath, contents);
      return load({ env, stateEnvPath });
    };
    const initial = await apply("FS_SAFE_PYTHON_MODE=require\n");
    expect(env.OPENCLAW_FS_SAFE_NATIVE_MODE).toBe("require");
    expect(initial.stateEnvAppliedKeys).toEqual(["FS_SAFE_PYTHON_MODE"]);
    expect(fsSafeEnvInput(env).OPENCLAW_FS_SAFE_NATIVE_MODE).toBeUndefined();
    await apply("OPENCLAW_FS_SAFE_NATIVE_MODE=off\n");
    expect(env.OPENCLAW_FS_SAFE_NATIVE_MODE).toBe("off");
    expect(fsSafeEnvInput(env).OPENCLAW_FS_SAFE_NATIVE_MODE).toBe("off");
  },
);
