import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveOpenClawPackageRoot } from "./openclaw-root.js";
import {
  fileIdentity as identity,
  immutableDescriptor,
  ownImmutableFixture,
  readText as text,
} from "./package-update-activation-fixtures.test-support.js";
import {
  prepareImmutableRecoveryRuntime,
  verifyImmutableRecoveryRuntime,
} from "./package-update-activation-immutable-recovery.js";
import {
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
vi.mock("./update-immutable-generation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-immutable-generation.js")>()),
  sealImmutableGeneration: vi.fn(async () => {}),
  verifyImmutableGeneration: vi.fn(),
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
const sha = "a".repeat(40);
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
const verify = (reference: Awaited<ReturnType<typeof prepare>>) =>
  verifyImmutableRecoveryRuntime({ reference, descriptor: record.descriptor, assertCurrent });

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
  for (const [file, content] of [
    ["dist/index.js", "built runtime"],
    ["dist/worker.js", "copied worker"],
    ["node_modules/fixture/index.cjs", "module.exports = 'copied dependency';"],
    ["node_modules/fixture/addon.node", "native artifact bytes"],
  ]) {
    fs.writeFileSync(path.join(source, file!), content!);
  }
  const dependencies = path.join(source, "node_modules");
  fs.symlinkSync(path.join(dependencies, "fixture"), path.join(dependencies, "absolute"));
  fs.symlinkSync("fixture", path.join(dependencies, "relative"));
  fs.writeFileSync(
    path.join(source, "openclaw.mjs"),
    `
import fs from 'node:fs';
import { createRequire } from 'node:module';
console.log(JSON.stringify({ args: process.argv.slice(2), dependency: createRequire(import.meta.url)('./node_modules/absolute/index.cjs'), worker: fs.readFileSync(new URL('./dist/worker.js', import.meta.url), 'utf8') }));
`,
  );
  ownImmutableFixture(parent);
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
  record = {
    revision: 1,
    prepared: null,
    descriptor: {
      ...immutableDescriptor(
        root,
        sha,
        createHash("sha256").update("built runtime").digest("hex"),
        {
          scope: "system",
          unit: "fixture.service",
          account: "fixture",
          stateDir: "/fixture/state",
          configPath: "/fixture/state/openclaw.json",
          profile: null,
        },
        "1:2",
      ),
      version: 2,
      activationEnabled: true,
    },
  };
});
afterEach(() => vi.restoreAllMocks());

it("runs retained recovery after the original generation is gone", async () => {
  const reference = await prepare();
  fs.rmSync(source, { recursive: true });
  await verify(reference);
  expect(text(reference.path, "node_modules/fixture/addon.node")).toBe("native artifact bytes");
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

it("reuses the verified copy and helper identities", async () => {
  const first = await prepare();
  const second = await prepare();
  expect(second).toEqual(first);
});

it("rejects a foreign checkout before publication", async () => {
  vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(path.dirname(source));
  await expect(prepare()).rejects.toThrow("sealed current or prepared generation");
  expect(fs.readdirSync(control)).toEqual([]);
});

it("preserves a recovery copy with a mismatched receipt", async () => {
  const destination = path.join(control, `recovery-${sha}`);
  fs.mkdirSync(path.join(destination, "dist"), { recursive: true, mode: 0o755 });
  fs.writeFileSync(path.join(destination, "dist", "index.js"), "foreign runtime");
  await expect(prepare()).rejects.toThrow("differs; it was preserved");
  expect(text(destination, "dist/index.js")).toBe("foreign runtime");
  expect(fs.existsSync(path.join(control, "recovery.mjs"))).toBe(false);
});

it("preserves the source on authority loss during copy verification", async () => {
  const verifyGeneration = vi.mocked(verifyImmutableGeneration).getMockImplementation()!;
  vi.mocked(verifyImmutableGeneration).mockImplementation(async (...args) => {
    const result = await verifyGeneration(...args);
    if (args[0] !== source) {
      current = false;
    }
    return result;
  });
  await expect(prepare()).rejects.toThrow("executor retired");
  expect(text(source, "dist/index.js")).toBe("built runtime");
  expect(fs.readdirSync(control)).toEqual([]);
});

it.each(["helper", "runtime"])("rejects changed %s bytes before recovery", async (changed) => {
  const reference = await prepare();
  const file =
    changed === "helper" ? reference.helperPath : path.join(reference.path, "dist", "index.js");
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, "foreign bytes");
  fs.chmodSync(file, 0o444);
  await expect(verify(reference)).rejects.toThrow(/artifact identity|recorded artifact/u);
});
