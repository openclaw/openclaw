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
vi.mock("../infra/gateway-lock.js", () => ({
  readActiveGatewayLockIdentity: () => Promise.resolve(undefined),
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

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerSecretsCli(program);
  return program;
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
  await createProgram().parseAsync(
    [
      "secrets",
      "store",
      "set",
      name,
      "--kind",
      "secret",
      "--value-file",
      valueFile,
      "--allow-host",
      host,
    ],
    { from: "user" },
  );
}

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
  it("keeps a stored secret write-only and host-bound when only its value is rotated", async () => {
    const root = createStoreRoot();
    const original = writeValueFile(root, "original.txt", "sk-original-credential");
    const rotated = writeValueFile(root, "rotated.txt", "sk-rotated-credential");

    await createProgram().parseAsync(
      [
        "secrets",
        "store",
        "set",
        "OPENAI_KEY",
        "--kind",
        "secret",
        "--value-file",
        original,
        "--allow-host",
        "api.openai.com",
      ],
      { from: "user" },
    );
    expect(await entryFor("OPENAI_KEY")).toMatchObject({
      kind: "secret",
      allowedHosts: ["api.openai.com"],
    });

    await createProgram().parseAsync(
      ["secrets", "store", "set", "OPENAI_KEY", "--value-file", rotated],
      { from: "user" },
    );

    const execEnvironment = await readSecretStoreExecEnvironment({
      includeSecretSentinels: true,
      database: mocks.database,
    });
    expect({
      kind: (await entryFor("OPENAI_KEY"))?.kind,
      allowedHosts: (await entryFor("OPENAI_KEY"))?.allowedHosts,
      valuePreview: (await entryFor("OPENAI_KEY"))?.valuePreview,
      plaintextInSubprocessEnv: execEnvironment.env?.OPENAI_KEY,
      sealedSentinel: execEnvironment.secretSentinels?.OPENAI_KEY !== undefined,
      egressBindings: execEnvironment.secretEgressBindings?.length ?? 0,
    }).toEqual({
      kind: "secret",
      allowedHosts: ["api.openai.com"],
      valuePreview: undefined,
      plaintextInSubprocessEnv: undefined,
      sealedSentinel: true,
      egressBindings: 1,
    });
    expect(await readSecretStoreValue({ scope, name: "OPENAI_KEY" })).toEqual({
      ok: true,
      value: "sk-rotated-credential",
    });
  });

  it("still downgrades a stored secret when --kind env is explicit", async () => {
    const root = createStoreRoot();
    const original = writeValueFile(root, "original.txt", "sk-original-credential");
    const rotated = writeValueFile(root, "rotated.txt", "sk-rotated-credential");

    await createProgram().parseAsync(
      ["secrets", "store", "set", "OPENAI_KEY", "--kind", "secret", "--value-file", original],
      { from: "user" },
    );
    await createProgram().parseAsync(
      ["secrets", "store", "set", "OPENAI_KEY", "--kind", "env", "--value-file", rotated],
      { from: "user" },
    );

    expect(await entryFor("OPENAI_KEY")).toMatchObject({
      kind: "env",
      valuePreview: expect.any(String),
    });
  });

  it("still classifies a brand-new entry from its name", async () => {
    const root = createStoreRoot();
    const credential = writeValueFile(root, "credential.txt", "sk-original-credential");

    await createProgram().parseAsync(
      ["secrets", "store", "set", "SERVICE_API_KEY", "--value-file", credential],
      { from: "user" },
    );
    await createProgram().parseAsync(
      ["secrets", "store", "set", "SERVICE_MODE", "--value", "production"],
      { from: "user" },
    );

    expect((await entryFor("SERVICE_API_KEY"))?.kind).toBe("secret");
    expect((await entryFor("SERVICE_MODE"))?.kind).toBe("env");
  });

  it("keeps import from downgrading an existing secret while classifying new names", async () => {
    const root = createStoreRoot();
    const original = writeValueFile(root, "original.txt", "sk-original-credential");
    const dotenvPath = writeValueFile(
      root,
      "values.env",
      "OPENAI_KEY=sk-rotated-credential\nSERVICE_MODE=production\n",
    );

    await createProgram().parseAsync(
      [
        "secrets",
        "store",
        "set",
        "OPENAI_KEY",
        "--kind",
        "secret",
        "--value-file",
        original,
        "--allow-host",
        "api.openai.com",
      ],
      { from: "user" },
    );
    await createProgram().parseAsync(
      ["secrets", "store", "import", "--from", dotenvPath, "--yes"],
      { from: "user" },
    );

    expect(await entryFor("OPENAI_KEY")).toMatchObject({
      kind: "secret",
      allowedHosts: ["api.openai.com"],
    });
    expect((await entryFor("OPENAI_KEY"))?.valuePreview).toBeUndefined();
    expect((await entryFor("SERVICE_MODE"))?.kind).toBe("env");
    expect(await readSecretStoreValue({ scope, name: "OPENAI_KEY" })).toEqual({
      ok: true,
      value: "sk-rotated-credential",
    });
  });

  it("applies a protection change made while set is waiting for its value", async () => {
    const root = createStoreRoot();
    const initial = writeValueFile(root, "initial.txt", "plain-original-value");
    const protectedValue = writeValueFile(root, "protected.txt", "sk-protected-credential");
    const rotated = writeValueFile(root, "rotated.txt", "sk-rotated-credential");

    await createProgram().parseAsync(
      ["secrets", "store", "set", "SERVICE_API_KEY", "--kind", "env", "--value-file", initial],
      { from: "user" },
    );
    expect((await entryFor("SERVICE_API_KEY"))?.kind).toBe("env");

    mocks.interleave.run = async () => {
      await protectEntry("SERVICE_API_KEY", protectedValue, "api.example.com");
      mocks.runtimeLogs.length = 0;
    };
    await createProgram().parseAsync(
      ["secrets", "store", "set", "SERVICE_API_KEY", "--value-file", rotated],
      { from: "user" },
    );

    expect(await exposureFor("SERVICE_API_KEY")).toEqual({
      kind: "secret",
      allowedHosts: ["api.example.com"],
      valuePreview: undefined,
      plaintextInSubprocessEnv: undefined,
      sealedSentinel: true,
      egressBindings: 1,
    });
    expect(await readSecretStoreValue({ scope, name: "SERVICE_API_KEY" })).toEqual({
      ok: true,
      value: "sk-rotated-credential",
    });
    expect(mocks.runtimeLogs).toContain("Stored SERVICE_API_KEY (secret).");
  });

  it.each([false, true])(
    "checks literal input against the transaction-resolved kind (explicit env: %s)",
    async (explicitEnv) => {
      createStoreRoot();
      await createProgram().parseAsync(
        ["secrets", "store", "set", "MY_APP_CRED", "--value", "initial-value"],
        { from: "user" },
      );
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
      const result = createProgram().parseAsync(
        [
          "secrets",
          "store",
          "set",
          "MY_APP_CRED",
          "--value",
          "literal-value",
          ...(explicitEnv ? ["--kind", "env"] : []),
        ],
        { from: "user" },
      );
      if (explicitEnv) {
        await result;
        expect(await entryFor("MY_APP_CRED")).toMatchObject({ kind: "env" });
        expect((await entryFor("MY_APP_CRED"))?.allowedHosts ?? []).toEqual([]);
      } else {
        await expect(result).rejects.toThrow("__exit__:2");
        expect(mocks.runtimeErrors.join("\n")).toContain("--value is refused for secret entries");
        expect(await exposureFor("MY_APP_CRED")).toEqual({
          kind: "secret",
          allowedHosts: ["api.example.com"],
          valuePreview: undefined,
          plaintextInSubprocessEnv: undefined,
          sealedSentinel: true,
          egressBindings: 1,
        });
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

  it("applies a protection change made while import is waiting for confirmation", async () => {
    const root = createStoreRoot();
    const initial = writeValueFile(root, "initial.txt", "plain-original-value");
    const protectedValue = writeValueFile(root, "protected.txt", "sk-protected-credential");
    const dotenvPath = writeValueFile(
      root,
      "values.env",
      "SERVICE_API_KEY=sk-rotated-credential\n",
    );

    await createProgram().parseAsync(
      ["secrets", "store", "set", "SERVICE_API_KEY", "--kind", "env", "--value-file", initial],
      { from: "user" },
    );
    expect((await entryFor("SERVICE_API_KEY"))?.kind).toBe("env");

    const stdinIsTty = process.stdin.isTTY;
    const stdoutIsTty = process.stdout.isTTY;
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    mocks.interleave.run = () => protectEntry("SERVICE_API_KEY", protectedValue, "api.example.com");
    try {
      await createProgram().parseAsync(["secrets", "store", "import", "--from", dotenvPath], {
        from: "user",
      });
    } finally {
      process.stdin.isTTY = stdinIsTty;
      process.stdout.isTTY = stdoutIsTty;
    }

    expect(await exposureFor("SERVICE_API_KEY")).toEqual({
      kind: "secret",
      allowedHosts: ["api.example.com"],
      valuePreview: undefined,
      plaintextInSubprocessEnv: undefined,
      sealedSentinel: true,
      egressBindings: 1,
    });
  });

  it("writes no import entry when a protection change during confirmation invalidates a later one", async () => {
    const root = createStoreRoot();
    const initial = writeValueFile(root, "initial.txt", "plain-original-value");
    const protectedValue = writeValueFile(root, "protected.txt", "sk-protected-credential");
    const dotenvPath = writeValueFile(
      root,
      "values.env",
      "SERVICE_MODE=production-next\nSERVICE_API_KEY=\n",
    );

    await createProgram().parseAsync(
      ["secrets", "store", "set", "SERVICE_API_KEY", "--kind", "env", "--value-file", initial],
      { from: "user" },
    );
    expect((await entryFor("SERVICE_API_KEY"))?.kind).toBe("env");
    expect(await entryFor("SERVICE_MODE")).toBeUndefined();

    const stdinIsTty = process.stdin.isTTY;
    const stdoutIsTty = process.stdout.isTTY;
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    mocks.interleave.run = () => protectEntry("SERVICE_API_KEY", protectedValue, "api.example.com");
    try {
      await expect(
        createProgram().parseAsync(["secrets", "store", "import", "--from", dotenvPath], {
          from: "user",
        }),
      ).rejects.toThrow("__exit__:2");
    } finally {
      process.stdin.isTTY = stdinIsTty;
      process.stdout.isTTY = stdoutIsTty;
    }

    expect(mocks.runtimeErrors.join("\n")).toContain("Secret store value is empty");
    expect(await entryFor("SERVICE_MODE")).toBeUndefined();
    expect(await exposureFor("SERVICE_API_KEY")).toEqual({
      kind: "secret",
      allowedHosts: ["api.example.com"],
      valuePreview: undefined,
      plaintextInSubprocessEnv: undefined,
      sealedSentinel: true,
      egressBindings: 1,
    });
  });

  it("still honours an explicit --kind when the entry changes while set waits", async () => {
    const root = createStoreRoot();
    const initial = writeValueFile(root, "initial.txt", "plain-original-value");
    const protectedValue = writeValueFile(root, "protected.txt", "sk-protected-credential");
    const rotated = writeValueFile(root, "rotated.txt", "plain-rotated-value");

    await createProgram().parseAsync(
      ["secrets", "store", "set", "SERVICE_API_KEY", "--kind", "env", "--value-file", initial],
      { from: "user" },
    );

    mocks.interleave.run = () => protectEntry("SERVICE_API_KEY", protectedValue, "api.example.com");
    await createProgram().parseAsync(
      ["secrets", "store", "set", "SERVICE_API_KEY", "--kind", "env", "--value-file", rotated],
      { from: "user" },
    );

    expect(await entryFor("SERVICE_API_KEY")).toMatchObject({
      kind: "env",
      valuePreview: expect.any(String),
    });
    expect((await entryFor("SERVICE_API_KEY"))?.allowedHosts ?? []).toEqual([]);
  });
});
