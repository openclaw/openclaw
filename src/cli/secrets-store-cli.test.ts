import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { registerSecretsCli } from "./secrets-cli.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const mocks = await vi.hoisted(async () => {
  const { createCliRuntimeMock } = await import("./test-runtime-mock.js");
  return {
    ...createCliRuntimeMock(vi),
    list: vi.fn(),
    read: vi.fn(),
    write: vi.fn(),
    writeBatch: vi.fn(),
    updateHosts: vi.fn(),
    remove: vi.fn(),
    purge: vi.fn(),
  };
});

vi.mock("../runtime.js", () => ({ defaultRuntime: mocks.defaultRuntime }));
vi.mock("./one-shot-exit.js", () => ({
  exitCliAfterOutput: (runtime: typeof mocks.defaultRuntime, exitCode: number) =>
    runtime.exit(exitCode),
}));
vi.mock("../secrets/store/secret-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../secrets/store/secret-store.js")>();
  return {
    // Keep validation real while observing whether the CLI reaches a store mutation.
    SecretStoreValidationError: actual.SecretStoreValidationError,
    assertSecretStoreValue: actual.assertSecretStoreValue,
    normalizeSecretAllowedHosts: actual.normalizeSecretAllowedHosts,
    SECRET_STORE_VALUE_MAX_BYTES: actual.SECRET_STORE_VALUE_MAX_BYTES,
    listSecretStoreEntries: (params: unknown) => mocks.list(params),
    readSecretStoreValue: (params: unknown) => mocks.read(params),
    writeSecretStoreEntry: (params: unknown) => mocks.write(params),
    writeSecretStoreEntries: (params: unknown) => mocks.writeBatch(params),
    updateSecretStoreAllowedHosts: (params: unknown) => mocks.updateHosts(params),
    deleteSecretStoreEntry: (params: unknown) => mocks.remove(params),
    purgeExpiredSecretStoreEntries: () => mocks.purge(),
  };
});
// mock-isolation: These policy tests use the offline branch; owner routing has its own boundary suite.
vi.mock("./local-state-owner.js", () => import("./secrets-store-cli.test-support.js"));

function run(...args: string[]) {
  const program = new Command().exitOverride();
  registerSecretsCli(program);
  return program.parseAsync(["secrets", "store", ...args], { from: "user" });
}

async function inputFile(value: string) {
  const file = path.join(tempDirs.make("store-cli-"), "input");
  await fs.writeFile(file, value);
  return file;
}

beforeEach(() => {
  mocks.runtimeLogs.length = 0;
  mocks.runtimeErrors.length = 0;
  mocks.list.mockReset().mockReturnValue([]);
  mocks.read.mockReset();
  mocks.write.mockReset();
  mocks.writeBatch.mockReset();
  mocks.updateHosts.mockReset();
  mocks.remove.mockReset();
  mocks.purge.mockReset();
  for (const mock of Object.values(mocks.defaultRuntime)) {
    mock.mockClear();
  }
});

describe("secrets store CLI", () => {
  it.each(["set", "import"])("preserves credentials on redacted %s", async (command) => {
    const file = await inputFile(
      command === "set"
        ? "__OPENCLAW_REDACTED__"
        : "OPENCLAW_GATEWAY_TOKEN=__OPENCLAW_REDACTED__\n",
    );
    mocks.read.mockResolvedValue({ ok: true, value: "synthetic-existing-token" });
    await run(
      ...(command === "set"
        ? ["set", "OPENCLAW_GATEWAY_TOKEN", "--value-file", file]
        : ["import", "--from", file, "--yes"]),
    );
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.writeBatch).not.toHaveBeenCalled();
    expect(mocks.runtimeLogs.join("\n")).toContain(
      "Skipped redacted value for OPENCLAW_GATEWAY_TOKEN; existing entry unchanged.",
    );
  });

  it("refuses a redacted import without a usable existing credential before writing other entries", async () => {
    const file = await inputFile(
      "SERVICE_MODE=test\nOPENCLAW_GATEWAY_TOKEN=__OPENCLAW_REDACTED__\n",
    );
    mocks.read.mockResolvedValue({ ok: false, error: { code: "SECRET_STORE_NOT_FOUND" } });
    await expect(run("import", "--from", file, "--yes")).rejects.toThrow("__exit__:2");
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.writeBatch).not.toHaveBeenCalled();
    expect(mocks.runtimeErrors.join("\n")).toContain("OPENCLAW_GATEWAY_TOKEN");
  });
  it("writes JSON results for list and get", async () => {
    const entry = { name: "SERVICE_MODE", kind: "env" };
    const list = [{ ...entry, valuePreview: "production" }];
    mocks.list.mockReturnValueOnce(list).mockReturnValueOnce([entry]);
    mocks.read.mockResolvedValueOnce({ ok: true, value: "production" });
    await run("list", "--json");
    await run("get", "SERVICE_MODE", "--json");
    expect(mocks.runtimeLogs).toHaveLength(2);
    expect(mocks.defaultRuntime.writeJson.mock.calls).toEqual([
      [list],
      [{ ...entry, value: "production" }],
    ]);
    expect(mocks.runtimeErrors).toHaveLength(0);
  });

  it("escapes readable env values while preserving JSON and plain output", async () => {
    const value = "café\u001b[31m\noperator-forged\tend\rrow\u0007";
    const entry = { name: "SERVICE_MODE", kind: "env", valuePreview: value };
    mocks.list.mockReturnValue([entry]);
    mocks.read.mockResolvedValue({ ok: true, value });

    await run("list");
    await run("get", "SERVICE_MODE");
    expect(mocks.runtimeLogs).toEqual([
      "SERVICE_MODE [env] = café\\noperator-forged\\tend\\rrow",
      "SERVICE_MODE=café\\noperator-forged\\tend\\rrow",
    ]);

    mocks.runtimeLogs.length = 0;
    await run("list", "--json");
    await run("get", "SERVICE_MODE", "--json");
    expect(JSON.parse(mocks.runtimeLogs[0] ?? "")).toEqual([entry]);
    expect(JSON.parse(mocks.runtimeLogs[1] ?? "")).toEqual({
      name: "SERVICE_MODE",
      kind: "env",
      value,
    });

    mocks.runtimeLogs.length = 0;
    await run("list", "--plain");
    await run("get", "SERVICE_MODE", "--plain");
    expect(mocks.runtimeLogs).toEqual([`SERVICE_MODE\tenv\t${value}\t`, value]);
  });

  it("shows non-secret allowed-host metadata in list output", async () => {
    const allowedHosts = ["api.example.com", "uploads.example.com"];
    mocks.list.mockReturnValue([{ name: "SERVICE_API_KEY", kind: "secret", allowedHosts }]);

    await run("list");

    expect(mocks.runtimeLogs.join("\n")).toContain(
      "allowed hosts: api.example.com, uploads.example.com",
    );
  });

  it("refuses --value for secret entries with all safe alternatives and exit 2", async () => {
    await expect(
      run("set", "SERVICE_API_KEY", "--kind", "secret", "--value", "leaked"),
    ).rejects.toThrow("__exit__:2");

    expect(mocks.runtimeErrors.join("\n")).toContain("stdin pipe");
    expect(mocks.runtimeErrors.join("\n")).toContain("--value-file");
    expect(mocks.runtimeErrors.join("\n")).toContain("interactive no-echo prompt");
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("reports an oversized --value-file as validation (exit 2), matching the stdin path", async () => {
    const file = await inputFile("a".repeat(64 * 1024 + 1));
    await expect(
      run("set", "BIG_ENV_VALUE", "--kind", "env", "--value-file", file),
    ).rejects.toThrow("__exit__:2");
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it.each(["secret", "env"])("validates an empty %s value during set dry-run", async (kind) => {
    const valueFile = await inputFile("");
    const command = run(
      "set",
      "SERVICE_VALUE",
      "--kind",
      kind,
      "--value-file",
      valueFile,
      "--dry-run",
    );
    if (kind === "secret") {
      await expect(command).rejects.toThrow("__exit__:2");
      expect(mocks.runtimeErrors.join("\n")).toContain("Secret store value is empty");
    } else {
      await command;
      expect(mocks.runtimeLogs.join("\n")).toContain("Would set SERVICE_VALUE (env)");
    }
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("refuses get for secret entries without reading their values", async () => {
    mocks.list.mockReturnValue([{ name: "SERVICE_API_KEY", kind: "secret" }]);
    await expect(run("get", "SERVICE_API_KEY")).rejects.toThrow("__exit__:2");

    expect(mocks.runtimeErrors.join("\n")).toContain("write-only by design");
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("normalizes repeatable allowed hosts and can clear them without replacing the secret", async () => {
    mocks.list.mockReturnValue([{ name: "MISC_VALUE", kind: "secret" }]);

    await run(
      "set",
      "MISC_VALUE",
      "--allow-host",
      "API.EXAMPLE.COM",
      "--allow-host",
      "bücher.example",
    );
    await run("set", "MISC_VALUE", "--clear-allowed-hosts");

    for (const [index, allowedHosts] of [
      ["api.example.com", "xn--bcher-kva.example"],
      [],
    ].entries()) {
      expect(mocks.updateHosts).toHaveBeenNthCalledWith(
        index + 1,
        expect.objectContaining({
          scope: { kind: "team" },
          name: "MISC_VALUE",
          allowedHosts,
          updatedBy: "cli",
        }),
      );
    }
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("rejects wildcard allowed hosts before reading or writing a value", async () => {
    await expect(run("set", "SERVICE_API_KEY", "--allow-host", "*.example.com")).rejects.toThrow(
      "__exit__:2",
    );

    expect(mocks.runtimeErrors.join("\n")).toContain("cannot contain a wildcard");
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.updateHosts).not.toHaveBeenCalled();
  });

  it.each([
    [["get", "MISSING_VALUE", "--json"], 3, 'Secret store entry "MISSING_VALUE" was not found.'],
    [["list", "--json"], 1, "database unavailable"],
  ] as const)("writes one JSON failure for %j", async (args, exitCode, message) => {
    if (exitCode === 1) {
      mocks.list.mockImplementationOnce(() => {
        throw new Error(message);
      });
    }

    await expect(run(...args)).rejects.toThrow(`__exit__:${exitCode}`);

    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledTimes(1);
    expect(mocks.runtimeLogs).toHaveLength(1);
    expect(JSON.parse(mocks.runtimeLogs[0] ?? "")).toEqual({
      ok: false,
      error: { type: "cli_error", message },
    });
    expect(mocks.runtimeErrors).toHaveLength(0);
  });

  it("keeps rm idempotent when entries are already missing", async () => {
    await run("rm", "MISSING_VALUE", "--yes");
    await run("rm", "MISSING_VALUE", "--yes");

    expect(mocks.remove).toHaveBeenCalledTimes(2);
    expect(mocks.runtimeErrors).toEqual([]);
  });

  it("imports quoted and multiline dotenv values without exposing them", async () => {
    const privateKey = "-----BEGIN PRIVATE KEY-----\nmultiline-body\n-----END PRIVATE KEY-----";
    const dotenvPath = await inputFile(
      [
        'SERVICE_URL="https://service.test/path with spaces"',
        `SERVICE_PRIVATE_KEY="${privateKey}"`,
        "SERVICE_EMPTY=",
      ].join("\n"),
    );
    await run("import", "--from", dotenvPath, "--yes");

    expect(mocks.writeBatch).toHaveBeenCalledTimes(1);
    expect(mocks.writeBatch.mock.calls[0]?.[0]?.entries).toEqual(
      [
        ["SERVICE_URL", "https://service.test/path with spaces", "env"],
        ["SERVICE_PRIVATE_KEY", privateKey, "secret"],
        ["SERVICE_EMPTY", "", "env"],
      ].map(([name, value, kind]) => ({ name, value, kind })),
    );
    const output = [...mocks.runtimeLogs, ...mocks.runtimeErrors].join("\n");
    expect(output).not.toContain("multiline-body");
  });
});
