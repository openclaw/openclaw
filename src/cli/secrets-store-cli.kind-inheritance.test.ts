import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import "../test-utils/prepare-compiled-subprocesses.js";
import { registerSecretsCli } from "./secrets-cli.js";

const mocks = await vi.hoisted(async () => {
  const { createCliRuntimeMock } = await import("./test-runtime-mock.js");
  return {
    ...createCliRuntimeMock(vi),
    database: { path: "" } as { path: string },
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
vi.mock("./local-state-owner.js", () => ({
  runWithLocalStateOwner: async ({
    runLocal,
  }: Parameters<typeof import("./local-state-owner.js").runWithLocalStateOwner>[0]) =>
    runLocal({
      env: process.env,
      config: {},
      signal: new AbortController().signal,
      assertCurrent() {},
    }),
}));
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

async function runPendingInterleave(): Promise<void> {
  const pending = mocks.interleave.run;
  mocks.interleave.run = undefined;
  await pending?.();
}
vi.mock("../secrets/store/secret-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../secrets/store/secret-store.js")>();
  const { captureSecretStoreExpiryCutoffs, purgeExpiredSecretStoreEntriesInDatabase } =
    await import("../secrets/store/secret-store-expiry.kernel.js");
  const withDb = <T extends { database?: unknown }>(params: T) => ({
    ...params,
    database: mocks.database,
  });
  return {
    ...actual,
    listSecretStoreEntries: (p: Parameters<typeof actual.listSecretStoreEntries>[0]) =>
      actual.listSecretStoreEntries(withDb(p)),
    writeSecretStoreEntry: async (p: Parameters<typeof actual.writeSecretStoreEntry>[0]) => {
      const pending = mocks.beforeWrite.run;
      mocks.beforeWrite.run = undefined;
      await pending?.();
      return actual.writeSecretStoreEntry(withDb(p));
    },
    writeSecretStoreEntries: (p: Parameters<typeof actual.writeSecretStoreEntries>[0]) =>
      actual.writeSecretStoreEntries(withDb(p)),
    updateSecretStoreAllowedHosts: (
      p: Parameters<typeof actual.updateSecretStoreAllowedHosts>[0],
    ) => actual.updateSecretStoreAllowedHosts(withDb(p)),
    readSecretStoreValue: (p: Parameters<typeof actual.readSecretStoreValue>[0]) =>
      actual.readSecretStoreValue(withDb(p)),
    deleteSecretStoreEntry: (p: Parameters<typeof actual.deleteSecretStoreEntry>[0]) =>
      actual.deleteSecretStoreEntry(withDb(p)),
    // Same kernel the state worker runs, applied directly so the write needs no
    // host-broker worker thread (the CLI test pool runs files off the main thread).
    purgeExpiredSecretStoreEntries: () =>
      purgeExpiredSecretStoreEntriesInDatabase(captureSecretStoreExpiryCutoffs(), mocks.database),
  };
});

const {
  listSecretStoreEntries,
  readSecretStoreExecEnvironment,
  readSecretStoreValue,
  writeSecretStoreEntry,
} = await import("../secrets/store/secret-store.js");

const scope = { kind: "team" } as const;
const roots: string[] = [];

async function run(...args: string[]): Promise<void> {
  const program = new Command().exitOverride();
  registerSecretsCli(program);
  await program.parseAsync(["secrets", "store", ...args], { from: "user" });
}

function createStoreRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-store-kind-")));
  roots.push(root);
  mocks.database.path = path.join(root, "state.sqlite");
  return root;
}

function writeValueFile(root: string, fileName: string, value: string): string {
  const filePath = path.join(root, fileName);
  fs.writeFileSync(filePath, value);
  return filePath;
}

async function entryFor(name: string) {
  return (await listSecretStoreEntries({ scope, database: mocks.database })).find(
    (entry) => entry.name === name,
  );
}

async function protectEntry(name: string, valueFile: string, host: string): Promise<void> {
  await run("set", name, "--kind", "secret", "--value-file", valueFile, "--allow-host", host);
}

const protectedExposure = (host: string) => ({
  kind: "secret",
  allowedHosts: [host],
  valuePreview: undefined,
  plaintextInSubprocessEnv: undefined,
  sealedSentinel: true,
  egressBindings: 1,
});

async function exposureFor(name: string) {
  const entry = await entryFor(name);
  const execEnvironment = await readSecretStoreExecEnvironment({
    includeSecretSentinels: true,
    database: mocks.database,
  });
  return {
    kind: entry?.kind,
    allowedHosts: entry?.allowedHosts,
    valuePreview: entry?.valuePreview,
    plaintextInSubprocessEnv: execEnvironment.env?.[name],
    sealedSentinel: execEnvironment.secretSentinels?.[name] !== undefined,
    egressBindings: execEnvironment.secretEgressBindings?.length ?? 0,
  };
}

afterEach(async () => {
  mocks.interleave.run = undefined;
  mocks.beforeWrite.run = undefined;
  await closeOpenClawStateDatabaseAsync();
  mocks.runtimeLogs.length = 0;
  mocks.runtimeErrors.length = 0;
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("secrets store kind inheritance", () => {
  it.each([
    { concurrent: false, explicitEnv: false },
    { concurrent: false, explicitEnv: true },
    { concurrent: true, explicitEnv: false },
    { concurrent: true, explicitEnv: true },
  ])(
    "rotates a value with concurrent=$concurrent and explicitEnv=$explicitEnv",
    async ({ concurrent, explicitEnv }) => {
      const root = createStoreRoot();
      const name = concurrent ? "SERVICE_API_KEY" : "OPENAI_KEY";
      const host = concurrent ? "api.example.com" : "api.openai.com";
      const original = writeValueFile(
        root,
        "original.txt",
        concurrent ? "plain-original-value" : "sk-original-credential",
      );
      const rotatedValue =
        concurrent && explicitEnv ? "plain-rotated-value" : "sk-rotated-credential";
      const rotated = writeValueFile(root, "rotated.txt", rotatedValue);
      if (concurrent) {
        await run("set", name, "--kind", "env", "--value-file", original);
        expect((await entryFor(name))?.kind).toBe("env");
        const protectedValue = writeValueFile(root, "protected.txt", "sk-protected-credential");
        mocks.interleave.run = async () => {
          await protectEntry(name, protectedValue, host);
          mocks.runtimeLogs.length = 0;
        };
      } else {
        await run(
          "set",
          name,
          "--kind",
          "secret",
          "--value-file",
          original,
          ...(explicitEnv ? [] : ["--allow-host", host]),
        );
        if (!explicitEnv) {
          expect(await entryFor(name)).toMatchObject({ kind: "secret", allowedHosts: [host] });
        }
      }
      await run("set", name, "--value-file", rotated, ...(explicitEnv ? ["--kind", "env"] : []));
      if (explicitEnv) {
        expect(await entryFor(name)).toMatchObject({
          kind: "env",
          valuePreview: expect.any(String),
        });
        if (concurrent) {
          expect((await entryFor(name))?.allowedHosts ?? []).toEqual([]);
        }
      } else {
        expect(await exposureFor(name)).toEqual(protectedExposure(host));
        expect(await readSecretStoreValue({ scope, name })).toEqual({
          ok: true,
          value: rotatedValue,
        });
        if (concurrent) {
          expect(mocks.runtimeLogs).toContain("Stored SERVICE_API_KEY (secret).");
        }
      }
    },
  );

  it("still classifies a brand-new entry from its name", async () => {
    const root = createStoreRoot();
    const credential = writeValueFile(root, "credential.txt", "sk-original-credential");
    await run("set", "SERVICE_API_KEY", "--value-file", credential);
    await run("set", "SERVICE_MODE", "--value", "production");
    expect((await entryFor("SERVICE_API_KEY"))?.kind).toBe("secret");
    expect((await entryFor("SERVICE_MODE"))?.kind).toBe("env");
  });

  it.each(["stored", "concurrent", "invalidated batch"])(
    "inherits live secret protection when importing a %s entry",
    async (mode) => {
      const root = createStoreRoot();
      const concurrent = mode !== "stored";
      const invalid = mode === "invalidated batch";
      const name = concurrent ? "SERVICE_API_KEY" : "OPENAI_KEY";
      const host = concurrent ? "api.example.com" : "api.openai.com";
      const original = writeValueFile(
        root,
        "original.txt",
        concurrent ? "plain-original-value" : "sk-original-credential",
      );
      const dotenvPath = writeValueFile(
        root,
        "values.env",
        invalid
          ? "SERVICE_MODE=production-next\nSERVICE_API_KEY=\n"
          : `${name}=sk-rotated-credential\n${concurrent ? "" : "SERVICE_MODE=production\n"}`,
      );
      if (concurrent) {
        await run("set", name, "--kind", "env", "--value-file", original);
        expect((await entryFor(name))?.kind).toBe("env");
        const protectedValue = writeValueFile(root, "protected.txt", "sk-protected-credential");
        mocks.interleave.run = () => protectEntry(name, protectedValue, host);
      } else {
        await protectEntry(name, original, host);
      }
      if (invalid) {
        expect(await entryFor("SERVICE_MODE")).toBeUndefined();
      }
      const stdinIsTty = process.stdin.isTTY;
      const stdoutIsTty = process.stdout.isTTY;
      if (concurrent) {
        process.stdin.isTTY = true;
        process.stdout.isTTY = true;
      }
      try {
        const result = run("import", "--from", dotenvPath, ...(concurrent ? [] : ["--yes"]));
        if (invalid) {
          await expect(result).rejects.toThrow("__exit__:2");
        } else {
          await result;
        }
      } finally {
        process.stdin.isTTY = stdinIsTty;
        process.stdout.isTTY = stdoutIsTty;
      }
      expect(await exposureFor(name)).toEqual(protectedExposure(host));
      if (invalid) {
        expect(mocks.runtimeErrors.join("\n")).toContain("Secret store value is empty");
        expect(await entryFor("SERVICE_MODE")).toBeUndefined();
      } else if (!concurrent) {
        expect((await entryFor("SERVICE_MODE"))?.kind).toBe("env");
        expect(await readSecretStoreValue({ scope, name })).toEqual({
          ok: true,
          value: "sk-rotated-credential",
        });
      }
    },
  );

  it.each([false, true])(
    "checks literal input against the transaction-resolved kind (explicit env: %s)",
    async (explicitEnv) => {
      createStoreRoot();
      await run("set", "MY_APP_CRED", "--value", "initial-value");
      // Models another process committing after metadata preflight, before this writer enters SQLite.
      mocks.beforeWrite.run = async () => {
        await writeSecretStoreEntry({
          scope,
          name: "MY_APP_CRED",
          value: "protected-value",
          kind: "secret",
          allowedHosts: ["api.example.com"],
          updatedBy: "competing-writer",
        });
      };
      const result = run(
        "set",
        "MY_APP_CRED",
        "--value",
        "literal-value",
        ...(explicitEnv ? ["--kind", "env"] : []),
      );
      if (explicitEnv) {
        await result;
        expect(await entryFor("MY_APP_CRED")).toMatchObject({ kind: "env" });
        expect((await entryFor("MY_APP_CRED"))?.allowedHosts ?? []).toEqual([]);
      } else {
        await expect(result).rejects.toThrow("__exit__:2");
        expect(mocks.runtimeErrors.join("\n")).toContain("--value is refused for secret entries");
        expect(await exposureFor("MY_APP_CRED")).toEqual(protectedExposure("api.example.com"));
      }
      expect(await readSecretStoreValue({ scope, name: "MY_APP_CRED" })).toEqual({
        ok: true,
        value: explicitEnv ? "literal-value" : "protected-value",
      });
      expect([...mocks.runtimeLogs, ...mocks.runtimeErrors].join("\n")).not.toContain(
        "literal-value",
      );
    },
  );
});
