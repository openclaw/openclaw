import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveOpenClawPackageRoot } from "./openclaw-root.js";
import {
  prepareImmutableRecoveryRuntime,
  verifyImmutableRecoveryRuntime,
} from "./package-update-activation-immutable-recovery.js";
import {
  packageActivationRuntimeIdentity,
  resolvePackageActivationAnchor,
  resolvePackageActivationControl,
} from "./package-update-activation-paths.js";
import { verifyImmutableGeneration } from "./update-immutable-generation.js";
import type { ImmutableInstallRecord } from "./update-immutable-install-schema.js";

vi.mock("./openclaw-root.js", () => ({ resolveOpenClawPackageRoot: vi.fn() }));
vi.mock("./package-update-activation-immutable.js", () => ({
  assertImmutableInstallRecordCurrent: (_record: unknown, assertCurrent: () => void) =>
    assertCurrent(),
}));
vi.mock("./update-immutable-generation.js", () => ({
  sealImmutableGeneration: vi.fn(async () => {}),
  verifyImmutableGeneration: vi.fn(),
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
const sha = "a".repeat(40);
const identity = (file: string) => {
  const stat = fs.lstatSync(file);
  return `${stat.dev}:${stat.ino}`;
};
let record: ImmutableInstallRecord;
let source: string;
let control: string;
let current: boolean;
const assertCurrent = () => {
  if (!current) {
    throw new Error("executor retired");
  }
};
const prepare = () => prepareImmutableRecoveryRuntime({ record, assertCurrent });

beforeEach(() => {
  vi.resetAllMocks();
  current = true;
  const parent = dirs.make("immutable-recovery-");
  const root = path.join(parent, "installation");
  source = path.join(root, "releases", sha);
  control = resolvePackageActivationControl(resolvePackageActivationAnchor(root));
  fs.mkdirSync(path.join(source, "dist"), { recursive: true, mode: 0o755 });
  fs.mkdirSync(path.join(source, "node_modules", "fixture"), { recursive: true, mode: 0o755 });
  fs.mkdirSync(control, { mode: 0o755 });
  fs.writeFileSync(path.join(source, "dist", "index.js"), "built runtime");
  fs.writeFileSync(path.join(source, "dist", "worker.js"), "copied worker");
  fs.writeFileSync(
    path.join(source, "node_modules", "fixture", "index.cjs"),
    "module.exports = 'copied dependency';",
  );
  fs.writeFileSync(
    path.join(source, "node_modules", "fixture", "addon.node"),
    "native artifact bytes",
  );
  fs.symlinkSync(
    path.join(source, "node_modules", "fixture"),
    path.join(source, "node_modules", "absolute"),
  );
  fs.symlinkSync("fixture", path.join(source, "node_modules", "relative"));
  fs.writeFileSync(
    path.join(source, "openclaw.mjs"),
    `
import fs from 'node:fs';
import { createRequire } from 'node:module';
console.log(JSON.stringify({ args: process.argv.slice(2), dependency: createRequire(import.meta.url)('./node_modules/absolute/index.cjs'), worker: fs.readFileSync(new URL('./dist/worker.js', import.meta.url), 'utf8') }));
`,
  );
  // Permissions and object identities stay real; only synthetic root ownership
  // is substituted so this contract also runs in unprivileged Testbox workers.
  const lstat = fs.lstatSync;
  vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
    const stat = lstat(...args);
    if (stat && String(args[0]).startsWith(`${parent}${path.sep}`)) {
      Object.defineProperty(stat, "uid", { value: typeof stat.uid === "bigint" ? 0n : 0 });
    }
    return stat;
  });
  vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(source);
  vi.mocked(verifyImmutableGeneration).mockImplementation(async (directory, expectedSha) => {
    expect(expectedSha).toBe(sha);
    return {
      identity: identity(directory),
      buildDigest: createHash("sha256")
        .update(fs.readFileSync(path.join(directory, "dist", "index.js")))
        .digest("hex"),
    };
  });
  const runtime = fs.realpathSync(process.execPath);
  record = {
    revision: 1,
    descriptor: {
      version: 2,
      activationEnabled: true,
      kind: "immutable",
      root,
      rootIdentity: identity(root),
      releasesIdentity: identity(path.join(root, "releases")),
      current: {
        sha,
        path: source,
        identity: identity(source),
        pointerIdentity: "1:2",
        buildDigest: createHash("sha256").update("built runtime").digest("hex"),
      },
      service: {
        scope: "system",
        unit: "fixture.service",
        account: "fixture",
        stateDir: "/fixture/state",
        configPath: "/fixture/state/openclaw.json",
        profile: null,
      },
      runtime: { path: runtime, identity: packageActivationRuntimeIdentity(runtime) },
      source: "https://github.com/openclaw/openclaw.git",
    },
    prepared: null,
  };
});
afterEach(() => vi.restoreAllMocks());

it("launches the retained product recovery entry with its dependencies after the original generation is gone", async () => {
  const reference = await prepare();
  fs.rmSync(source, { recursive: true });
  await verifyImmutableRecoveryRuntime({ reference, descriptor: record.descriptor, assertCurrent });
  expect(
    fs.readFileSync(path.join(reference.path, "node_modules", "fixture", "addon.node"), "utf8"),
  ).toBe("native artifact bytes");
  expect(fs.realpathSync(path.join(reference.path, "node_modules", "relative"))).toBe(
    path.join(reference.path, "node_modules", "fixture"),
  );
  const result = spawnSync(
    process.execPath,
    [reference.helperPath, "--json", "--timeout", "10", "--drain-timeout", "30"],
    {
      encoding: "utf8",
      timeout: 5000,
    },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    args: [
      "update",
      "recover",
      "--root",
      record.descriptor.root,
      "--json",
      "--timeout",
      "10",
      "--drain-timeout",
      "30",
    ],
    dependency: "copied dependency",
    worker: "copied worker",
  });
});

it("reuses an already verified copy and stable helper without replacing either identity", async () => {
  const first = await prepare();
  const second = await prepare();
  expect(second).toEqual(first);
});

it("refuses a foreign invoking checkout before publishing a recovery artifact", async () => {
  vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(path.dirname(source));
  await expect(prepare()).rejects.toThrow("sealed current or prepared generation");
  expect(fs.readdirSync(control)).toEqual([]);
});

it("preserves a preexisting recovery copy that fails its build receipt", async () => {
  const destination = path.join(control, `recovery-${sha}`);
  fs.mkdirSync(path.join(destination, "dist"), { recursive: true, mode: 0o755 });
  fs.writeFileSync(path.join(destination, "dist", "index.js"), "foreign runtime");
  await expect(prepare()).rejects.toThrow("differs; it was preserved");
  expect(fs.readFileSync(path.join(destination, "dist", "index.js"), "utf8")).toBe(
    "foreign runtime",
  );
  expect(fs.existsSync(path.join(control, "recovery.mjs"))).toBe(false);
});

it("keeps the serving runtime and omits publication when authority is lost during copy verification", async () => {
  const verify = vi.mocked(verifyImmutableGeneration).getMockImplementation()!;
  vi.mocked(verifyImmutableGeneration).mockImplementation(async (...args) => {
    const result = await verify(...args);
    if (args[0] !== source) {
      current = false;
    }
    return result;
  });
  await expect(prepare()).rejects.toThrow("executor retired");
  expect(fs.readFileSync(path.join(source, "dist", "index.js"), "utf8")).toBe("built runtime");
  expect(fs.readdirSync(control)).toEqual([]);
});

it.each(["helper", "runtime"])("rejects changed %s bytes before recovery", async (changed) => {
  const reference = await prepare();
  const file =
    changed === "helper" ? reference.helperPath : path.join(reference.path, "dist", "index.js");
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, "foreign bytes");
  fs.chmodSync(file, 0o444);
  await expect(
    verifyImmutableRecoveryRuntime({ reference, descriptor: record.descriptor, assertCurrent }),
  ).rejects.toThrow(/artifact identity|recorded artifact/u);
});
