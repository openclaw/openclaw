/** Tests SecretRef provider resolution for env, file, and exec sources. */
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as waitForReapTick } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { withinTest } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/config.js";
import type {
  FileSecretProviderConfig,
  ManualExecSecretProviderConfig,
  SecretProviderConfig,
} from "../config/types.secrets.js";
import { isPidAlive } from "../shared/pid-alive.js";
import {
  killPidIfAlive,
  readPidFile,
  writeForkingNoOutputScript,
} from "../test-utils/process-tree.js";
import { INVALID_EXEC_SECRET_REF_IDS } from "../test-utils/secret-ref-test-vectors.js";
import {
  withMockedWindowsAclVerificationUnavailable,
  withMockedWindowsPlatform,
} from "../test-utils/vitest-spies.js";
import {
  describeSecretResolutionError,
  describeSecretResolutionOperatorDiagnostic,
  describeSecretResolutionOperatorRecovery,
  isMissingSecretRefResolutionError,
} from "./resolve-errors.js";
import {
  isProviderScopedSecretResolutionError,
  resolveSecretRefString,
  resolveSecretRefValue,
  resolveSecretRefValues,
} from "./resolve.js";

async function writeSecureFile(filePath: string, content: string, mode = 0o600): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  try {
    await fs.writeFile(tempPath, content, "utf8");
    await fs.chmod(tempPath, mode);
    await fs.rename(tempPath, filePath);
  } catch (err) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
}

describe("secret ref resolver", () => {
  const isWindows = process.platform === "win32";
  function itPosix(name: string, fn: () => Promise<void> | void) {
    it.skipIf(isWindows)(name, fn);
  }
  let fixtureRoot = "";
  let receipts: FixtureReceiptChannel;
  let caseId = 0;
  let execFastExitScriptPath = "";
  const execResponses = {
    v1: '{"protocolVersion":1,"values":{"openai/api-key":"value:openai/api-key"}}',
    plain: "plain-secret",
    v2: '{"protocolVersion":2,"values":{"openai/api-key":"x"}}',
    missing: '{"protocolVersion":1,"values":{}}',
    inherited: '{"protocolVersion":1,"values":{"toString":"resolved"},"errors":{}}',
    error:
      '{"protocolVersion":1,"values":{},"errors":{"openai/api-key":{"code":"NOT_FOUND","message":"provider-private-detail-7f3c"}}}',
    unsafe:
      '{"protocolVersion":1,"values":{},"errors":{"openai/api-key":{"code":"PROVIDERPRIVATEDETAIL9C2E"}}}',
    invalid: "not-json",
  };
  const execScript = (name: keyof typeof execResponses) =>
    path.join(fixtureRoot, "shared-exec", `${name}.sh`);

  const createCaseDir = async (label: string): Promise<string> => {
    const dir = path.join(fixtureRoot, `${label}-${caseId++}`);
    await fs.mkdir(dir);
    return dir;
  };

  type ExecProviderConfig = ManualExecSecretProviderConfig & { allowSymlinkCommand?: boolean };
  type FileProviderConfig = FileSecretProviderConfig;

  function createExecProviderConfig(
    command: string,
    overrides: Partial<ExecProviderConfig> = {},
  ): ExecProviderConfig {
    return { source: "exec", command, passEnv: ["PATH"], ...overrides };
  }

  function providerOptions(name: string, provider: SecretProviderConfig) {
    return { config: { secrets: { providers: { [name]: provider } } } };
  }

  async function resolveExecSecret(
    command: string,
    overrides: Partial<ExecProviderConfig> = {},
    id = "openai/api-key",
  ): Promise<string> {
    return resolveSecretRefString(
      { source: "exec", provider: "execmain", id },
      providerOptions("execmain", createExecProviderConfig(command, overrides)),
    );
  }

  function createFileProviderConfig(
    filePath: string,
    overrides: Partial<FileProviderConfig> = {},
  ): FileProviderConfig {
    return { source: "file", path: filePath, mode: "json", ...overrides };
  }

  function resolveFileSecret(
    filePath: string,
    overrides: Partial<FileProviderConfig> = {},
    id = "/providers/openai/apiKey",
  ) {
    return resolveSecretRefString(
      { source: "file", provider: "filemain", id },
      providerOptions("filemain", createFileProviderConfig(filePath, overrides)),
    );
  }

  const filePayload = JSON.stringify({ providers: { openai: { apiKey: "sk-file-value" } } }); // pragma: allowlist secret

  function expectWindowsProviderError(error: unknown, kind: "file" | "exec") {
    expect(isProviderScopedSecretResolutionError(error)).toBe(true);
    expect(error).toHaveProperty("code", "SECRET_PROVIDER_PATH_SECURITY_UNVERIFIABLE");
    expect(describeSecretResolutionError(error)).toBe("secret provider failed");
    expect(describeSecretResolutionOperatorDiagnostic(error)).toBe(
      "Windows path security could not be verified",
    );
    expect(describeSecretResolutionOperatorRecovery(error)).toBe(
      `Restore Windows path security verification, or use an existing ${kind === "file" ? "secret file" : "provider command"} whose owner and ACLs OpenClaw can verify`,
    );
  }

  beforeAll(async () => {
    receipts = await openFixtureReceiptChannel();
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-resolve-"));
    const sharedExecDir = path.join(fixtureRoot, "shared-exec");
    await fs.mkdir(sharedExecDir, { recursive: true });

    for (const [name, output] of Object.entries(execResponses)) {
      await writeSecureFile(
        path.join(sharedExecDir, `${name}.sh`),
        `#!/bin/sh\nprintf '%s' '${output}'`,
        0o700,
      );
    }

    execFastExitScriptPath = path.join(sharedExecDir, "resolver-fast-exit.sh");
    await writeSecureFile(execFastExitScriptPath, ["#!/bin/sh", "exit 0"].join("\n"), 0o700);
  });

  afterAll(async () => {
    await receipts?.close();
    if (!fixtureRoot) {
      return;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("does not rewrite an explicit default provider to a configured alias", async () => {
    const ref = { source: "env", provider: "default", id: "MISSING_API_KEY" } as const;
    const error = await resolveSecretRefValue(ref, {
      config: {
        secrets: {
          defaults: { env: "primary" },
          providers: { primary: { source: "env" } },
        },
      },
      env: {},
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Secret provider "default" is not configured');
    expect(isMissingSecretRefResolutionError({ ref, error })).toBe(false);
  });

  itPosix(
    "recovers file refs after replacing a hardlinked credential with a private file",
    async () => {
      const root = await createCaseDir("file");
      const filePath = path.join(root, "secrets.json");
      const aliasPath = path.join(root, "old-secret-link.json");
      await writeSecureFile(filePath, filePayload);

      const resolve = () => resolveFileSecret(filePath);
      await expect(resolve()).resolves.toBe("sk-file-value");
      const original = await fs.stat(filePath);
      const contents = await fs.readFile(filePath, "utf8");
      expect(original.nlink).toBe(1);

      await fs.link(filePath, aliasPath);
      expect((await fs.stat(filePath)).nlink).toBe(2);
      await expect(resolve()).rejects.toMatchObject({
        code: "SECRET_PROVIDER_UNAVAILABLE",
        cause: { code: "hardlink" },
      });

      await writeSecureFile(filePath, contents);
      const recovered = await fs.stat(filePath);
      const oldAlias = await fs.stat(aliasPath);
      expect(recovered.nlink).toBe(1);
      expect(recovered.mode & 0o777).toBe(0o600);
      expect(recovered.ino).not.toBe(original.ino);
      expect(oldAlias.ino).toBe(original.ino);
      expect(oldAlias.nlink).toBe(1);
      await expect(fs.readFile(aliasPath, "utf8")).resolves.toBe(contents);
      await expect(resolve()).resolves.toBe("sk-file-value");
    },
  );

  itPosix("classifies an out-of-bounds file pointer as a missing ref", async () => {
    const root = await createCaseDir("file-missing-index");
    const filePath = path.join(root, "secrets.json");
    await writeSecureFile(filePath, JSON.stringify({ providers: [] }));
    const ref = { source: "file", provider: "filemain", id: "/providers/0" } as const;
    const error = await resolveSecretRefValue(
      ref,
      providerOptions("filemain", createFileProviderConfig(filePath)),
    ).catch((caught: unknown) => caught);

    expect(isMissingSecretRefResolutionError({ ref, error })).toBe(true);
  });

  itPosix(
    "classifies omitted and NOT_FOUND exec ids as missing but keeps other errors fail-closed",
    async () => {
      const ref = { source: "exec", provider: "execmain", id: "openai/api-key" } as const;
      const configFor = (command: string): OpenClawConfig =>
        providerOptions("execmain", createExecProviderConfig(command)).config;
      const omittedError = await resolveSecretRefValue(ref, {
        config: configFor(execScript("missing")),
      }).catch((error: unknown) => error);
      const missingError = await resolveSecretRefValue(ref, {
        config: configFor(execScript("error")),
      }).catch((error: unknown) => error);
      const providerError = await resolveSecretRefValue(ref, {
        config: configFor(execScript("unsafe")),
      }).catch((error: unknown) => error);

      expect(isMissingSecretRefResolutionError({ ref, error: omittedError })).toBe(true);
      expect(isMissingSecretRefResolutionError({ ref, error: missingError })).toBe(true);
      expect(isMissingSecretRefResolutionError({ ref, error: providerError })).toBe(false);
      expect(missingError).toMatchObject({
        message: 'Exec provider "execmain" failed for id "openai/api-key" (NOT_FOUND).',
      });
      expect(providerError).toMatchObject({
        message: 'Exec provider "execmain" failed for id "openai/api-key".',
      });
    },
  );

  itPosix("clamps oversized exec provider timeouts", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const value = await resolveExecSecret(execScript("v1"), {
      timeoutMs: Number.MAX_SAFE_INTEGER,
      noOutputTimeoutMs: Number.MAX_SAFE_INTEGER,
    });

    expect(value).toBe("value:openai/api-key");
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });

  it.skipIf(isWindows)(
    "kills forked exec provider children on no-output timeout",
    async ({ signal }) => {
      const root = await createCaseDir("exec-fork-timeout");
      const scriptPath = await writeForkingNoOutputScript(root, receipts.endpoint);
      const pidPath = path.join(root, "forked.pid");
      let childPid: number | undefined;
      let resultPromise: Promise<string> | undefined;
      const nativeSetTimeout = globalThis.setTimeout;
      let noOutputTimeout: (() => void) | undefined;
      const setTimeoutSpy = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation((callback, delay, ...args) => {
          if (delay === 1_000) {
            noOutputTimeout = () => callback(...args);
            return nativeSetTimeout(() => undefined, 60_000);
          }
          return nativeSetTimeout(callback, delay, ...args);
        });

      try {
        resultPromise = resolveExecSecret(scriptPath, {
          env: { NODE_BINARY: process.execPath, PID_FILE: pidPath },
          noOutputTimeoutMs: 1_000,
          timeoutMs: 10_000,
        });
        const resultErrorPromise = resultPromise.catch((error: unknown) => error);
        // The PID record precedes the receipt; operation settlement can win the socket race.
        const settled = resultPromise.then(
          () => {
            if (!fsSync.existsSync(pidPath)) {
              throw new Error(`Timed out waiting for pid file: ${pidPath}`);
            }
          },
          (error: unknown) => {
            if (!fsSync.existsSync(pidPath)) {
              throw error;
            }
          },
        );
        await withinTest(Promise.race([receipts.waitFor(pidPath, "ready"), settled]), signal);
        childPid = await readPidFile(pidPath);
        expect(isPidAlive(childPid)).toBe(true);
        expectDefined(noOutputTimeout, "no-output timeout")();
        const error = await withinTest(resultErrorPromise, signal);

        expect(isProviderScopedSecretResolutionError(error)).toBe(true);
        expect(error).toMatchObject({
          code: "SECRET_PROVIDER_UNAVAILABLE",
          source: "exec",
          provider: "execmain",
          message: 'Exec provider "execmain" produced no output for 1000ms.',
        });
        // The provider outcome does not expose the adopted descendant's native reap event.
        while (isPidAlive(childPid)) {
          await waitForReapTick(25, undefined, { signal }).catch((cause: unknown) => {
            throw new Error(`Exec-provider descendant ${childPid} stayed alive`, { cause });
          });
        }
        expect(isPidAlive(childPid)).toBe(false);
      } finally {
        setTimeoutSpy.mockRestore();
        noOutputTimeout?.();
        killPidIfAlive(childPid);
        await resultPromise?.catch(() => {});
      }
    },
  );

  itPosix("supports non-JSON single-value exec output when jsonOnly is false", async () => {
    const value = await resolveExecSecret(execScript("plain"), { jsonOnly: false });
    expect(value).toBe("plain-secret");
  });

  itPosix(
    "tolerates stdin write errors when exec provider exits before consuming a large request",
    async () => {
      const refs = Array.from({ length: 256 }, (_, index) => ({
        source: "exec" as const,
        provider: "execmain",
        id: `openai/${String(index).padStart(3, "0")}/${"x".repeat(240)}`,
      }));
      await expect(
        resolveSecretRefValues(
          refs,
          providerOptions("execmain", { source: "exec", command: execFastExitScriptPath }),
        ),
      ).rejects.toThrow('Exec provider "execmain" returned empty stdout.');
    },
  );

  it("enforces the built-in per-provider reference limit", async () => {
    const refs = Array.from({ length: 513 }, (_, index) => ({
      source: "env" as const,
      provider: "default",
      id: `SECRET_${index}`,
    }));

    await expect(resolveSecretRefValues(refs, { config: {} })).rejects.toThrow(
      'Secret provider "default" exceeded maxRefsPerProvider (512).',
    );
  });

  itPosix("rejects symlinks before trusted-directory evaluation", async () => {
    const root = await createCaseDir("exec-link-trusted");
    const symlinkPath = path.join(root, "resolver-link.mjs");
    await fs.symlink(execScript("plain"), symlinkPath);

    await expect(
      resolveExecSecret(symlinkPath, {
        jsonOnly: false,
        allowSymlinkCommand: true,
        trustedDirs: [root],
      }),
    ).rejects.toThrow("must not be a symlink");
  });

  itPosix("rejects exec refs when protocolVersion is not 1", async () => {
    await expect(resolveExecSecret(execScript("v2"))).rejects.toThrow("protocolVersion must be 1");
  });

  itPosix("rejects exec refs when missing response id is inherited", async () => {
    await expect(resolveExecSecret(execScript("missing"), {}, "toString")).rejects.toThrow(
      'response missing id "toString"',
    );
  });

  itPosix("ignores inherited exec response errors", async () => {
    await expect(resolveExecSecret(execScript("inherited"), {}, "toString")).resolves.toBe(
      "resolved",
    );
  });

  itPosix("rejects exec refs with invalid JSON when jsonOnly is true", async () => {
    await expect(resolveExecSecret(execScript("invalid"), { jsonOnly: true })).rejects.toThrow(
      "returned invalid JSON",
    );
  });

  itPosix("times out file provider reads when timeoutMs elapses", async () => {
    const root = await createCaseDir("file-timeout");
    const filePath = path.join(root, "secrets.json");
    await writeSecureFile(filePath, filePayload);

    const sampleHandle = await fs.open(filePath, "r");
    const fileHandlePrototype = Object.getPrototypeOf(sampleHandle) as {
      read: typeof sampleHandle.read;
    };
    await sampleHandle.close();
    const readSpy = vi
      .spyOn(fileHandlePrototype, "read")
      .mockImplementation(() => new Promise(() => {}) as never);

    try {
      await expect(resolveFileSecret(filePath, { timeoutMs: 5 })).rejects.toThrow(
        'File provider "filemain" timed out',
      );
    } finally {
      readSpy.mockRestore();
    }
  });

  it("rejects misconfigured provider source mismatches", async () => {
    await expect(
      resolveSecretRefValue(
        { source: "exec", provider: "default", id: "abc" },
        providerOptions("default", { source: "env" }),
      ),
    ).rejects.toThrow('has source "env" but ref requests "exec"');
  });

  it("rejects invalid exec ids before provider resolution", async () => {
    for (const id of INVALID_EXEC_SECRET_REF_IDS) {
      await expect(
        resolveSecretRefValue({ source: "exec", provider: "vault", id }, { config: {} }),
      ).rejects.toThrow(/Exec secret reference id must match|Secret reference id is empty/);
    }
  });

  it("rejects invalid env, file, and provider refs before provider resolution", async () => {
    await expect(
      resolveSecretRefValue({ source: "env", provider: "default", id: "bad id" }, { config: {} }),
    ).rejects.toThrow("Env secret reference id must match");

    await expect(
      resolveSecretRefValue(
        { source: "file", provider: "default", id: "providers/openai/apiKey" },
        { config: {} },
      ),
    ).rejects.toThrow("File secret reference id must be an absolute JSON pointer");

    await expect(
      resolveSecretRefValue(
        { source: "env", provider: "Default", id: "OPENAI_API_KEY" },
        { config: {} },
      ),
    ).rejects.toThrow("Secret reference provider must match");
  });

  it("strips UTF-8 BOM from file provider singleValue mode", async () => {
    const dir = await createCaseDir("bom-single");
    const filePath = path.join(dir, "secret-with-bom.txt");
    const bom = "\uFEFF";
    await writeSecureFile(filePath, `${bom}my-secret-value\n`);

    const value = await resolveFileSecret(filePath, { mode: "singleValue" }, "value");
    expect(value).toBe("my-secret-value");
  });

  it("fails closed on Windows when file provider ACL source is unknown", async () => {
    const dir = await createCaseDir("win-acl");
    await withMockedWindowsAclVerificationUnavailable(
      path.join(dir, "missing-windows-system-root"),
      async () => {
        const filePath = path.join(dir, "secrets.json");
        await writeSecureFile(filePath, '{"token":"abc123"}');

        const error = await resolveFileSecret(filePath, {}, "/token").catch(
          (caught: unknown) => caught,
        );
        expectWindowsProviderError(error, "file");
      },
    );
  });

  it("fails closed on Windows when exec provider ACL source is unknown", async () => {
    const dir = await createCaseDir("win-exec-acl");
    await withMockedWindowsAclVerificationUnavailable(
      path.join(dir, "missing-windows-system-root"),
      async () => {
        const markerPath = path.join(dir, "executed");
        const commandPath = path.join(dir, "resolver.sh");
        await writeSecureFile(
          commandPath,
          ["#!/bin/sh", `touch ${JSON.stringify(markerPath)}`].join("\n"),
          0o700,
        );

        const error = await resolveExecSecret(commandPath).catch((caught: unknown) => caught);

        expectWindowsProviderError(error, "exec");
        await expect(fs.access(markerPath)).rejects.toThrow();
      },
    );
  });

  it("keeps a failed Windows exec permission restat as a generic failure", async () => {
    await withMockedWindowsPlatform(async () => {
      const dir = await createCaseDir("win-exec-restat");
      const markerPath = path.join(dir, "executed");
      const commandPath = path.join(dir, "resolver.sh");
      await writeSecureFile(
        commandPath,
        ["#!/bin/sh", `touch ${JSON.stringify(markerPath)}`].join("\n"),
        0o700,
      );

      const originalLstat = fsSync.lstatSync.bind(fsSync);
      let commandPathStats = 0;
      const lstatSpy = vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
        if (String(args[0]) === commandPath && ++commandPathStats === 2) {
          throw Object.assign(new Error("provider command disappeared"), { code: "ENOENT" });
        }
        return originalLstat(...args);
      });
      try {
        const error = await resolveExecSecret(commandPath).catch((caught: unknown) => caught);

        expect(commandPathStats).toBe(2);
        expect(isProviderScopedSecretResolutionError(error)).toBe(true);
        expect(error).toHaveProperty("code", "SECRET_PROVIDER_UNAVAILABLE");
        expect(describeSecretResolutionError(error)).toBe("secret provider failed");
        expect(describeSecretResolutionOperatorDiagnostic(error)).toBeUndefined();
        expect(describeSecretResolutionOperatorRecovery(error)).toBeUndefined();
        await expect(fs.access(markerPath)).rejects.toThrow();
      } finally {
        lstatSpy.mockRestore();
      }
    });
  });
});
