import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSecretRefString, resolveSecretRefValue } from "./resolve.js";

async function writeSecureFile(filePath: string, content: string, mode = 0o600): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  await fs.chmod(filePath, mode);
}

describe("secret ref resolver", () => {
  const cleanupRoots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (cleanupRoots.length > 0) {
      const root = cleanupRoots.pop();
      if (!root) {
        continue;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
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
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-resolve-file-"));
    cleanupRoots.push(root);
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
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-resolve-exec-"));
    cleanupRoots.push(root);
    const scriptPath = path.join(root, "resolver.mjs");
    await writeSecureFile(
      scriptPath,
      [
        "#!/usr/bin/env node",
        "import fs from 'node:fs';",
        "const req = JSON.parse(fs.readFileSync(0, 'utf8'));",
        "const values = Object.fromEntries((req.ids ?? []).map((id) => [id, `value:${id}`]));",
        "process.stdout.write(JSON.stringify({ protocolVersion: 1, values }));",
      ].join("\n"),
      0o700,
    );

    const value = await resolveSecretRefString(
      { source: "exec", provider: "execmain", id: "openai/api-key" },
      {
        config: {
          secrets: {
            providers: {
              execmain: {
                source: "exec",
                command: scriptPath,
                passEnv: ["PATH"],
              },
            },
          },
        },
      },
    );
    expect(value).toBe("value:openai/api-key");
  });

  it("supports non-JSON single-value exec output when jsonOnly is false", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-resolve-exec-plain-"));
    cleanupRoots.push(root);
    const scriptPath = path.join(root, "resolver-plain.mjs");
    await writeSecureFile(
      scriptPath,
      ["#!/usr/bin/env node", "process.stdout.write('plain-secret');"].join("\n"),
      0o700,
    );

    const value = await resolveSecretRefString(
      { source: "exec", provider: "execmain", id: "openai/api-key" },
      {
        config: {
          secrets: {
            providers: {
              execmain: {
                source: "exec",
                command: scriptPath,
                passEnv: ["PATH"],
                jsonOnly: false,
              },
            },
          },
        },
      },
    );
    expect(value).toBe("plain-secret");
  });

  it("rejects symlink command paths unless allowSymlinkCommand is enabled", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-resolve-exec-link-"));
    cleanupRoots.push(root);
    const scriptPath = path.join(root, "resolver-target.mjs");
    const symlinkPath = path.join(root, "resolver-link.mjs");
    await writeSecureFile(
      scriptPath,
      ["#!/usr/bin/env node", "process.stdout.write('plain-secret');"].join("\n"),
      0o700,
    );
    await fs.symlink(scriptPath, symlinkPath);

    await expect(
      resolveSecretRefString(
        { source: "exec", provider: "execmain", id: "openai/api-key" },
        {
          config: {
            secrets: {
              providers: {
                execmain: {
                  source: "exec",
                  command: symlinkPath,
                  passEnv: ["PATH"],
                  jsonOnly: false,
                },
              },
            },
          },
        },
      ),
    ).rejects.toThrow("must not be a symlink");
  });

  it("allows symlink command paths when allowSymlinkCommand is enabled", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-resolve-exec-link-"));
    cleanupRoots.push(root);
    const scriptPath = path.join(root, "resolver-target.mjs");
    const symlinkPath = path.join(root, "resolver-link.mjs");
    await writeSecureFile(
      scriptPath,
      ["#!/usr/bin/env node", "process.stdout.write('plain-secret');"].join("\n"),
      0o700,
    );
    await fs.symlink(scriptPath, symlinkPath);
    const trustedRoot = await fs.realpath(root);

    const value = await resolveSecretRefString(
      { source: "exec", provider: "execmain", id: "openai/api-key" },
      {
        config: {
          secrets: {
            providers: {
              execmain: {
                source: "exec",
                command: symlinkPath,
                passEnv: ["PATH"],
                jsonOnly: false,
                allowSymlinkCommand: true,
                trustedDirs: [trustedRoot],
              },
            },
          },
        },
      },
    );
    expect(value).toBe("plain-secret");
  });

  it("handles Homebrew-style symlinked exec commands with args only when explicitly allowed", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-resolve-homebrew-"));
    cleanupRoots.push(root);
    const binDir = path.join(root, "opt", "homebrew", "bin");
    const cellarDir = path.join(root, "opt", "homebrew", "Cellar", "node", "25.0.0", "bin");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(cellarDir, { recursive: true });

    const targetCommand = path.join(cellarDir, "node");
    const symlinkCommand = path.join(binDir, "node");
    await writeSecureFile(
      targetCommand,
      [
        `#!${process.execPath}`,
        "import fs from 'node:fs';",
        "const req = JSON.parse(fs.readFileSync(0, 'utf8'));",
        "const suffix = process.argv[2] ?? 'missing';",
        "const values = Object.fromEntries((req.ids ?? []).map((id) => [id, `${suffix}:${id}`]));",
        "process.stdout.write(JSON.stringify({ protocolVersion: 1, values }));",
      ].join("\n"),
      0o700,
    );
    await fs.symlink(targetCommand, symlinkCommand);
    const trustedRoot = await fs.realpath(root);

    await expect(
      resolveSecretRefString(
        { source: "exec", provider: "execmain", id: "openai/api-key" },
        {
          config: {
            secrets: {
              providers: {
                execmain: {
                  source: "exec",
                  command: symlinkCommand,
                  args: ["brew"],
                  passEnv: ["PATH"],
                },
              },
            },
          },
        },
      ),
    ).rejects.toThrow("must not be a symlink");

    const value = await resolveSecretRefString(
      { source: "exec", provider: "execmain", id: "openai/api-key" },
      {
        config: {
          secrets: {
            providers: {
              execmain: {
                source: "exec",
                command: symlinkCommand,
                args: ["brew"],
                allowSymlinkCommand: true,
                trustedDirs: [trustedRoot],
              },
            },
          },
        },
      },
    );
    expect(value).toBe("brew:openai/api-key");
  });

  it("checks trustedDirs against resolved symlink target", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-resolve-exec-link-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-resolve-exec-out-"));
    cleanupRoots.push(root);
    cleanupRoots.push(outside);
    const scriptPath = path.join(outside, "resolver-target.mjs");
    const symlinkPath = path.join(root, "resolver-link.mjs");
    await writeSecureFile(
      scriptPath,
      ["#!/usr/bin/env node", "process.stdout.write('plain-secret');"].join("\n"),
      0o700,
    );
    await fs.symlink(scriptPath, symlinkPath);

    await expect(
      resolveSecretRefString(
        { source: "exec", provider: "execmain", id: "openai/api-key" },
        {
          config: {
            secrets: {
              providers: {
                execmain: {
                  source: "exec",
                  command: symlinkPath,
                  passEnv: ["PATH"],
                  jsonOnly: false,
                  allowSymlinkCommand: true,
                  trustedDirs: [root],
                },
              },
            },
          },
        },
      ),
    ).rejects.toThrow("outside trustedDirs");
  });

  it("rejects exec refs when protocolVersion is not 1", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-secrets-resolve-exec-protocol-"),
    );
    cleanupRoots.push(root);
    const scriptPath = path.join(root, "resolver-protocol.mjs");
    await writeSecureFile(
      scriptPath,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify({ protocolVersion: 2, values: { 'openai/api-key': 'x' } }));",
      ].join("\n"),
      0o700,
    );

    await expect(
      resolveSecretRefString(
        { source: "exec", provider: "execmain", id: "openai/api-key" },
        {
          config: {
            secrets: {
              providers: {
                execmain: {
                  source: "exec",
                  command: scriptPath,
                  passEnv: ["PATH"],
                },
              },
            },
          },
        },
      ),
    ).rejects.toThrow("protocolVersion must be 1");
  });

  it("rejects exec refs when response omits requested id", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-resolve-exec-id-"));
    cleanupRoots.push(root);
    const scriptPath = path.join(root, "resolver-missing-id.mjs");
    await writeSecureFile(
      scriptPath,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify({ protocolVersion: 1, values: {} }));",
      ].join("\n"),
      0o700,
    );

    await expect(
      resolveSecretRefString(
        { source: "exec", provider: "execmain", id: "openai/api-key" },
        {
          config: {
            secrets: {
              providers: {
                execmain: {
                  source: "exec",
                  command: scriptPath,
                  passEnv: ["PATH"],
                },
              },
            },
          },
        },
      ),
    ).rejects.toThrow('response missing id "openai/api-key"');
  });

  it("rejects exec refs with invalid JSON when jsonOnly is true", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-resolve-exec-json-"));
    cleanupRoots.push(root);
    const scriptPath = path.join(root, "resolver-invalid-json.mjs");
    await writeSecureFile(
      scriptPath,
      ["#!/usr/bin/env node", "process.stdout.write('not-json');"].join("\n"),
      0o700,
    );

    await expect(
      resolveSecretRefString(
        { source: "exec", provider: "execmain", id: "openai/api-key" },
        {
          config: {
            secrets: {
              providers: {
                execmain: {
                  source: "exec",
                  command: scriptPath,
                  passEnv: ["PATH"],
                  jsonOnly: true,
                },
              },
            },
          },
        },
      ),
    ).rejects.toThrow("returned invalid JSON");
  });

  it("supports file singleValue mode with id=value", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-resolve-single-value-"));
    cleanupRoots.push(root);
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
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-resolve-timeout-"));
    cleanupRoots.push(root);
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
    vi.spyOn(fs, "readFile").mockImplementation(((
      targetPath: Parameters<typeof fs.readFile>[0],
      options?: Parameters<typeof fs.readFile>[1],
    ) => {
      if (typeof targetPath === "string" && targetPath === filePath) {
        return new Promise<Buffer>(() => {});
      }
      return originalReadFile(targetPath, options);
    }) as typeof fs.readFile);

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
