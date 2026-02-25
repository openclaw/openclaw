import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

  it("resolves file refs in jsonPointer mode", async () => {
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
                mode: "jsonPointer",
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

  it("supports file raw mode with id=value", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-resolve-raw-"));
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
                mode: "raw",
              },
            },
          },
        },
      },
    );
    expect(value).toBe("raw-token-value");
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
