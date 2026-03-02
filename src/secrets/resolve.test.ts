import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSecretRefString, resolveSecretRefValue } from "./resolve.js";

async function writeSecureFile(filePath: string, content: string, mode = 0o600): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  await fs.chmod(filePath, mode);
}

describe("secret ref resolver", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let execProtocolV1ScriptPath = "";
  let execPlainScriptPath = "";
  let execProtocolV2ScriptPath = "";
  let execMissingIdScriptPath = "";
  let execInvalidJsonScriptPath = "";
  let execFastExitScriptPath = "";

  const createCaseDir = async (label: string): Promise<string> => {
    const dir = path.join(fixtureRoot, `${label}-${caseId++}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };

  type ExecProviderConfig = {
    source: "exec";
    command: string;
    passEnv?: string[];
    jsonOnly?: boolean;
    allowSymlinkCommand?: boolean;
    trustedDirs?: string[];
    args?: string[];
  };

  function createExecProviderConfig(
    command: string,
    overrides: Partial<ExecProviderConfig> = {},
  ): ExecProviderConfig {
    return {
      source: "exec",
      command,
      passEnv: ["PATH"],
      ...overrides,
    };
  }

  async function resolveExecSecret(
    command: string,
    overrides: Partial<ExecProviderConfig> = {},
  ): Promise<string> {
    return resolveSecretRefString(
      { source: "exec", provider: "execmain", id: "openai/api-key" },
      {
        config: {
          secrets: {
            providers: {
              execmain: createExecProviderConfig(command, overrides),
            },
          },
        },
      },
    );
  }

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-resolve-"));
    const sharedExecDir = path.join(fixtureRoot, "shared-exec");
    await fs.mkdir(sharedExecDir, { recursive: true });

    execProtocolV1ScriptPath = path.join(sharedExecDir, "resolver-v1.sh");
    await writeSecureFile(
      execProtocolV1ScriptPath,
      [
        "#!/bin/sh",
        'printf \'{"protocolVersion":1,"values":{"openai/api-key":"value:openai/api-key"}}\'',
      ].join("\n"),
      0o700,
    );

    execPlainScriptPath = path.join(sharedExecDir, "resolver-plain.sh");
    await writeSecureFile(
      execPlainScriptPath,
      ["#!/bin/sh", "printf 'plain-secret'"].join("\n"),
      0o700,
    );

    execProtocolV2ScriptPath = path.join(sharedExecDir, "resolver-v2.sh");
    await writeSecureFile(
      execProtocolV2ScriptPath,
      ["#!/bin/sh", 'printf \'{"protocolVersion":2,"values":{"openai/api-key":"x"}}\''].join("\n"),
      0o700,
    );

    execMissingIdScriptPath = path.join(sharedExecDir, "resolver-missing-id.sh");
    await writeSecureFile(
      execMissingIdScriptPath,
      ["#!/bin/sh", 'printf \'{"protocolVersion":1,"values":{}}\''].join("\n"),
      0o700,
    );

    execInvalidJsonScriptPath = path.join(sharedExecDir, "resolver-invalid-json.sh");
    await writeSecureFile(
      execInvalidJsonScriptPath,
      ["#!/bin/sh", "printf 'not-json'"].join("\n"),
      0o700,
    );

    execFastExitScriptPath = path.join(sharedExecDir, "resolver-fast-exit.sh");
    await writeSecureFile(execFastExitScriptPath, ["#!/bin/sh", "exit 0"].join("\n"), 0o700);
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      return;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("resolves env refs via implicit default env provider", async () => {
    const config: OpenClawConfig = {};
    const value = await resolveSecretRefString(
      { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      {
        config,
        env: { OPENAI_API_KEY: "sk-env-value" },
      },
    );
    expect(value).toBe("sk-env-value");
  });

  it("resolves file refs in json mode", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await createCaseDir("file");
    const filePath = path.join(root, "secrets.json");
    await writeSecureFile(
      filePath,
      JSON.stringify({
        providers: {
          openai: {
            apiKey: "sk-file-value",
          },
        },
      }),
    );

    const value = await resolveSecretRefString(
      { source: "file", provider: "filemain", id: "/providers/openai/apiKey" },
      {
        config: {
          secrets: {
            providers: {
              filemain: {
                source: "file",
                path: filePath,
                mode: "json",
              },
            },
          },
        },
      },
    );
    expect(value).toBe("sk-file-value");
  });

  it("resolves exec refs with protocolVersion 1 response", async () => {
    if (process.platform === "win32") {
      return;
    }

    const value = await resolveExecSecret(execProtocolV1ScriptPath);
    expect(value).toBe("value:openai/api-key");
  });

  it("uses timeoutMs as the default no-output timeout for exec providers", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await createCaseDir("exec-delay");
    const scriptPath = path.join(root, "resolver-delay.mjs");
    await writeSecureFile(
      scriptPath,
      [
        "#!/usr/bin/env node",
        "setTimeout(() => {",
        "  process.stdout.write(JSON.stringify({ protocolVersion: 1, values: { delayed: 'ok' } }));",
        "}, 120);",
      ].join("\n"),
      0o700,
    );

    const value = await resolveSecretRefString(
      { source: "exec", provider: "execmain", id: "delayed" },
      {
        config: {
          secrets: {
            providers: {
              execmain: {
                source: "exec",
                command: scriptPath,
                passEnv: ["PATH"],
                timeoutMs: 500,
              },
            },
          },
        },
      },
    );
    expect(value).toBe("ok");
  });

  it("supports non-JSON single-value exec output when jsonOnly is false", async () => {
    if (process.platform === "win32") {
      return;
    }

    const value = await resolveExecSecret(execPlainScriptPath, { jsonOnly: false });
    expect(value).toBe("plain-secret");
  });

  it("ignores EPIPE when exec provider exits before consuming stdin", async () => {
    if (process.platform === "win32") {
      return;
    }
    const oversizedId = `openai/${"x".repeat(120_000)}`;
    await expect(
      resolveSecretRefString(
        { source: "exec", provider: "execmain", id: oversizedId },
        {
          config: {
            secrets: {
              providers: {
                execmain: {
                  source: "exec",
                  command: execFastExitScriptPath,
                },
              },
            },
          },
        },
      ),
    ).rejects.toThrow('Exec provider "execmain" returned empty stdout.');
  });

  it("rejects symlink command paths unless allowSymlinkCommand is enabled", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await createCaseDir("exec-link-reject");
    const symlinkPath = path.join(root, "resolver-link.mjs");
    await fs.symlink(execPlainScriptPath, symlinkPath);

    await expect(resolveExecSecret(symlinkPath, { jsonOnly: false })).rejects.toThrow(
      "must not be a symlink",
    );
  });

  it("allows symlink command paths when allowSymlinkCommand is enabled", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await createCaseDir("exec-link-allow");
    const symlinkPath = path.join(root, "resolver-link.mjs");
    await fs.symlink(execPlainScriptPath, symlinkPath);
    const trustedRoot = await fs.realpath(fixtureRoot);

    const value = await resolveExecSecret(symlinkPath, {
      jsonOnly: false,
      allowSymlinkCommand: true,
      trustedDirs: [trustedRoot],
    });
    expect(value).toBe("plain-secret");
  });

  it("handles Homebrew-style symlinked exec commands with args only when explicitly allowed", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await createCaseDir("homebrew");
    const binDir = path.join(root, "opt", "homebrew", "bin");
    const cellarDir = path.join(root, "opt", "homebrew", "Cellar", "node", "25.0.0", "bin");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(cellarDir, { recursive: true });

    const targetCommand = path.join(cellarDir, "node");
    const symlinkCommand = path.join(binDir, "node");
    await writeSecureFile(
      targetCommand,
      [
        "#!/bin/sh",
        'suffix="${1:-missing}"',
        'printf \'{"protocolVersion":1,"values":{"openai/api-key":"%s:openai/api-key"}}\' "$suffix"',
      ].join("\n"),
      0o700,
    );
    await fs.symlink(targetCommand, symlinkCommand);
    const trustedRoot = await fs.realpath(root);

    await expect(resolveExecSecret(symlinkCommand, { args: ["brew"] })).rejects.toThrow(
      "must not be a symlink",
    );

    const value = await resolveExecSecret(symlinkCommand, {
      args: ["brew"],
      allowSymlinkCommand: true,
      trustedDirs: [trustedRoot],
    });
    expect(value).toBe("brew:openai/api-key");
  });

  it("checks trustedDirs against resolved symlink target", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await createCaseDir("exec-link-trusted");
    const symlinkPath = path.join(root, "resolver-link.mjs");
    await fs.symlink(execPlainScriptPath, symlinkPath);

    await expect(
      resolveExecSecret(symlinkPath, {
        jsonOnly: false,
        allowSymlinkCommand: true,
        trustedDirs: [root],
      }),
    ).rejects.toThrow("outside trustedDirs");
  });

  it("rejects exec refs when protocolVersion is not 1", async () => {
    if (process.platform === "win32") {
      return;
    }
    await expect(resolveExecSecret(execProtocolV2ScriptPath)).rejects.toThrow(
      "protocolVersion must be 1",
    );
  });

  it("rejects exec refs when response omits requested id", async () => {
    if (process.platform === "win32") {
      return;
    }
    await expect(resolveExecSecret(execMissingIdScriptPath)).rejects.toThrow(
      'response missing id "openai/api-key"',
    );
  });

  it("rejects exec refs with invalid JSON when jsonOnly is true", async () => {
    if (process.platform === "win32") {
      return;
    }
    await expect(resolveExecSecret(execInvalidJsonScriptPath, { jsonOnly: true })).rejects.toThrow(
      "returned invalid JSON",
    );
  });

  it("supports file singleValue mode with id=value", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await createCaseDir("file-single-value");
    const filePath = path.join(root, "token.txt");
    await writeSecureFile(filePath, "raw-token-value\n");

    const value = await resolveSecretRefString(
      { source: "file", provider: "rawfile", id: "value" },
      {
        config: {
          secrets: {
            providers: {
              rawfile: {
                source: "file",
                path: filePath,
                mode: "singleValue",
              },
            },
          },
        },
      },
    );
    expect(value).toBe("raw-token-value");
  });

  it("times out file provider reads when timeoutMs elapses", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await createCaseDir("file-timeout");
    const filePath = path.join(root, "secrets.json");
    await writeSecureFile(
      filePath,
      JSON.stringify({
        providers: {
          openai: {
            apiKey: "sk-file-value",
          },
        },
      }),
    );

    const originalReadFile = fs.readFile.bind(fs);
    const readFileSpy = vi.spyOn(fs, "readFile").mockImplementation(((
      targetPath: Parameters<typeof fs.readFile>[0],
      options?: Parameters<typeof fs.readFile>[1],
    ) => {
      if (typeof targetPath === "string" && targetPath === filePath) {
        return new Promise<Buffer>(() => {});
      }
      return originalReadFile(targetPath, options);
    }) as typeof fs.readFile);

    try {
      await expect(
        resolveSecretRefString(
          { source: "file", provider: "filemain", id: "/providers/openai/apiKey" },
          {
            config: {
              secrets: {
                providers: {
                  filemain: {
                    source: "file",
                    path: filePath,
                    mode: "json",
                    timeoutMs: 5,
                  },
                },
              },
            },
          },
        ),
      ).rejects.toThrow('File provider "filemain" timed out');
    } finally {
      readFileSpy.mockRestore();
    }
  });

  it("rejects misconfigured provider source mismatches", async () => {
    await expect(
      resolveSecretRefValue(
        { source: "exec", provider: "default", id: "abc" },
        {
          config: {
            secrets: {
              providers: {
                default: {
                  source: "env",
                },
              },
            },
          },
        },
      ),
    ).rejects.toThrow('has source "env" but ref requests "exec"');
  });
});
