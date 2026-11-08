import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import "../test-utils/prepare-compiled-subprocesses.js";
import { registerSecretsCli } from "./secrets-cli.js";

const mocks = await vi.hoisted(async () => {
  const { createCliRuntimeMock } = await import("./test-runtime-mock.js");
  return {
    ...createCliRuntimeMock(vi),
    database: { path: "" },
    interleave: { run: undefined as (() => Promise<void>) | undefined },
    beforeWrite: { run: undefined as (() => Promise<void>) | undefined },
  };
});

vi.mock("../runtime.js", () => ({ defaultRuntime: mocks.defaultRuntime }));
vi.mock("./one-shot-exit.js", () => ({
  exitCliAfterOutput: (runtime: typeof mocks.defaultRuntime, exitCode: number) =>
    runtime.exit(exitCode),
}));
// mock-isolation: These policy tests use the offline branch; owner routing has its own boundary suite.
vi.mock("./local-state-owner.js", () => import("./secrets-store-cli.test-support.js"));
vi.mock("./secrets-store-input.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./secrets-store-input.js")>();
  return {
    ...actual,
    readSecretStoreInput: async (params: Parameters<typeof actual.readSecretStoreInput>[0]) => {
      const value = await actual.readSecretStoreInput(params);
      await runPendingInterleave();
      return value;
    },
  };
});
vi.mock("@clack/prompts", () => ({
  confirm: async () => {
    await runPendingInterleave();
    return true;
  },
  isCancel: () => false,
}));

async function runPendingInterleave(hook = mocks.interleave): Promise<void> {
  const pending = hook.run;
  hook.run = undefined;
  await pending?.();
}
vi.mock("../secrets/store/secret-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../secrets/store/secret-store.js")>();
  const { captureSecretStoreExpiryCutoffs, purgeExpiredSecretStoreEntriesInDatabase } =
    await import("../secrets/store/secret-store-expiry.kernel.js");
  function withDb<P extends { database?: unknown }, R>(fn: (params: P) => R) {
    return (params: P) => fn({ ...params, database: mocks.database });
  }
  return {
    ...actual,
    listSecretStoreEntries: withDb(actual.listSecretStoreEntries),
    writeSecretStoreEntry: async (p: Parameters<typeof actual.writeSecretStoreEntry>[0]) => {
      await runPendingInterleave(mocks.beforeWrite);
      return withDb(actual.writeSecretStoreEntry)(p);
    },
    writeSecretStoreEntries: withDb(actual.writeSecretStoreEntries),
    readSecretStoreValue: withDb(actual.readSecretStoreValue),
    // Same kernel the state worker runs, applied directly so the write needs no
    // host-broker worker thread (the CLI test pool runs files off the main thread).
    purgeExpiredSecretStoreEntries: () =>
      purgeExpiredSecretStoreEntriesInDatabase(captureSecretStoreExpiryCutoffs(), mocks.database)
        .removed,
  };
});

const store = await import("../secrets/store/secret-store.js");

const scope = { kind: "team" } as const;
let root: string;
const key = "OPENAI_KEY";
const host = "api.example.com";
const rotatedValue = "sk-rotated-credential";

async function run(...args: string[]): Promise<void> {
  const program = new Command().exitOverride();
  registerSecretsCli(program);
  await program.parseAsync(["secrets", "store", ...args], { from: "user" });
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-store-kind-")));
  mocks.database.path = path.join(root, "state.sqlite");
});

function file(value: string, fileName = "value.txt"): string {
  const filePath = path.join(root, fileName);
  fs.writeFileSync(filePath, value);
  return filePath;
}

async function entryFor(name = key) {
  return (await store.listSecretStoreEntries({ scope, database: mocks.database })).find(
    (entry) => entry.name === name,
  );
}

const setFile = (valueFile: string, ...args: string[]) =>
  run("set", key, "--value-file", valueFile, ...args);

async function expectProtected(name = key) {
  const entry = await entryFor(name);
  const execEnvironment = await store.readSecretStoreExecEnvironment({
    includeSecretSentinels: true,
    database: mocks.database,
  });
  expect(entry).toMatchObject({ kind: "secret", allowedHosts: [host] });
  expect(entry?.valuePreview).toBeUndefined();
  expect(execEnvironment.env?.[name]).toBeUndefined();
  expect(execEnvironment.secretSentinels?.[name]).toBeDefined();
  expect(execEnvironment.secretEgressBindings).toHaveLength(1);
}

async function expectValue(value: string, name = key) {
  expect(await store.readSecretStoreValue({ scope, name })).toEqual({ ok: true, value });
}

async function seed(concurrent: boolean, allowHosts = true): Promise<void> {
  const original = file(concurrent ? "plain-original-value" : "sk-original-credential");
  await setFile(
    original,
    "--kind",
    concurrent ? "env" : "secret",
    ...(!concurrent && allowHosts ? ["--allow-host", host] : []),
  );
  expect(await entryFor()).toMatchObject(
    concurrent
      ? { kind: "env" }
      : { kind: "secret", ...(allowHosts ? { allowedHosts: [host] } : {}) },
  );
  if (concurrent) {
    const protectedValue = file("sk-protected-credential", "protected.txt");
    mocks.interleave.run = async () => {
      await setFile(protectedValue, "--kind", "secret", "--allow-host", host);
      mocks.runtimeLogs.length = 0;
    };
  }
}

afterEach(async () => {
  mocks.interleave.run = undefined;
  mocks.beforeWrite.run = undefined;
  await closeOpenClawStateDatabaseAsync();
  mocks.runtimeLogs.length = 0;
  mocks.runtimeErrors.length = 0;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("secrets store kind inheritance", () => {
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])("rotates (concurrent: %s, explicit env: %s)", async (concurrent, explicitEnv) => {
    await seed(concurrent, !explicitEnv);
    const rotated = file(concurrent && explicitEnv ? "plain-rotated-value" : rotatedValue);
    await setFile(rotated, ...(explicitEnv ? ["--kind", "env"] : []));
    if (explicitEnv) {
      expect(await entryFor()).toMatchObject({
        kind: "env",
        valuePreview: expect.any(String),
      });
      if (concurrent) {
        expect((await entryFor())?.allowedHosts ?? []).toEqual([]);
      }
    } else {
      await expectProtected();
      await expectValue(rotatedValue);
      if (concurrent) {
        expect(mocks.runtimeLogs).toContain(`Stored ${key} (secret).`);
      }
    }
  });

  it("still classifies a brand-new entry from its name", async () => {
    await run("set", "SERVICE_API_KEY", "--value-file", file("sk-original-credential"));
    await run("set", "SERVICE_MODE", "--value", "production");
    expect((await entryFor("SERVICE_API_KEY"))?.kind).toBe("secret");
    expect((await entryFor("SERVICE_MODE"))?.kind).toBe("env");
  });

  it.each(["stored", "concurrent", "invalid"])("protects %s imports", async (mode) => {
    const concurrent = mode !== "stored";
    const invalid = mode === "invalid";
    const dotenvPath = file(
      invalid
        ? `SERVICE_MODE=production-next\n${key}=\n`
        : `${key}=${rotatedValue}\n${concurrent ? "" : "SERVICE_MODE=production\n"}`,
      "values.env",
    );
    await seed(concurrent);
    if (invalid) {
      expect(await entryFor("SERVICE_MODE")).toBeUndefined();
    }
    const tty = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };
    try {
      if (concurrent) {
        process.stdin.isTTY = process.stdout.isTTY = true;
      }
      const result = run("import", "--from", dotenvPath, ...(concurrent ? [] : ["--yes"]));
      if (invalid) {
        await expect(result).rejects.toThrow("__exit__:2");
      } else {
        await result;
      }
    } finally {
      process.stdin.isTTY = tty.stdin;
      process.stdout.isTTY = tty.stdout;
    }
    await expectProtected();
    if (invalid) {
      expect(mocks.runtimeErrors.join("\n")).toContain("Secret store value is empty");
      expect(await entryFor("SERVICE_MODE")).toBeUndefined();
    } else if (!concurrent) {
      expect((await entryFor("SERVICE_MODE"))?.kind).toBe("env");
      await expectValue(rotatedValue);
    }
  });

  it.each([false, true])("revalidates literal kind (explicit env: %s)", async (explicitEnv) => {
    const name = "MY_APP_CRED";
    await run("set", name, "--value", "initial-value");
    // Models another process committing after metadata preflight, before this writer enters SQLite.
    mocks.beforeWrite.run = async () => {
      await store.writeSecretStoreEntry({
        scope,
        name,
        value: "protected-value",
        kind: "secret",
        allowedHosts: [host],
        updatedBy: "competing-writer",
      });
    };
    const kindArgs = explicitEnv ? ["--kind", "env"] : [];
    const result = run("set", name, "--value", "literal", ...kindArgs);
    if (explicitEnv) {
      await result;
      expect(await entryFor(name)).toMatchObject({ kind: "env" });
      expect((await entryFor(name))?.allowedHosts ?? []).toEqual([]);
    } else {
      await expect(result).rejects.toThrow("__exit__:2");
      expect(mocks.runtimeErrors.join("\n")).toContain("--value is refused for secret entries");
      await expectProtected(name);
    }
    await expectValue(explicitEnv ? "literal" : "protected-value", name);
    expect([...mocks.runtimeLogs, ...mocks.runtimeErrors].join("\n")).not.toContain("literal");
  });
});
