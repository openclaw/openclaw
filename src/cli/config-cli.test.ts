import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.js";

/**
 * Test for issue #6070:
 * `openclaw config set/unset` must update snapshot.resolved (user config after $include/${ENV},
 * but before runtime defaults), so runtime defaults don't leak into the written config.
 */

const mockReadConfigFileSnapshot = vi.fn<() => Promise<ConfigFileSnapshot>>();
const mockWriteConfigFile = vi.fn<
  (cfg: OpenClawConfig, options?: { unsetPaths?: string[][] }) => Promise<void>
>(async () => {});
const mockResolveSecretRefValue = vi.fn();

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: () => mockReadConfigFileSnapshot(),
  writeConfigFile: (cfg: OpenClawConfig, options?: { unsetPaths?: string[][] }) =>
    mockWriteConfigFile(cfg, options),
}));

vi.mock("../secrets/resolve.js", () => ({
  resolveSecretRefValue: (...args: unknown[]) => mockResolveSecretRefValue(...args),
}));

const mockLog = vi.fn();
const mockError = vi.fn();
const mockExit = vi.fn((code: number) => {
  const errorMessages = mockError.mock.calls.map((c) => c.join(" ")).join("; ");
  throw new Error(`__exit__:${code} - ${errorMessages}`);
});

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: (...args: unknown[]) => mockLog(...args),
    error: (...args: unknown[]) => mockError(...args),
    exit: (code: number) => mockExit(code),
  },
}));

function buildSnapshot(params: {
  resolved: OpenClawConfig;
  config: OpenClawConfig;
}): ConfigFileSnapshot {
  return {
    path: "/tmp/openclaw.json",
    exists: true,
    raw: JSON.stringify(params.resolved),
    parsed: params.resolved,
    resolved: params.resolved,
    valid: true,
    config: params.config,
    issues: [],
    warnings: [],
    legacyIssues: [],
  };
}

function setSnapshot(resolved: OpenClawConfig, config: OpenClawConfig) {
  mockReadConfigFileSnapshot.mockResolvedValueOnce(buildSnapshot({ resolved, config }));
}

function setSnapshotOnce(snapshot: ConfigFileSnapshot) {
  mockReadConfigFileSnapshot.mockResolvedValueOnce(snapshot);
}

function withRuntimeDefaults(resolved: OpenClawConfig): OpenClawConfig {
  return {
    ...resolved,
    agents: {
      ...resolved.agents,
      defaults: {
        model: "gpt-5.2",
      } as never,
    } as never,
  };
}

function makeInvalidSnapshot(params: {
  issues: ConfigFileSnapshot["issues"];
  path?: string;
}): ConfigFileSnapshot {
  return {
    path: params.path ?? "/tmp/custom-openclaw.json",
    exists: true,
    raw: "{}",
    parsed: {},
    resolved: {},
    valid: false,
    config: {},
    issues: params.issues,
    warnings: [],
    legacyIssues: [],
  };
}

async function runValidateJsonAndGetPayload() {
  await expect(runConfigCommand(["config", "validate", "--json"])).rejects.toThrow("__exit__:1");
  const raw = mockLog.mock.calls.at(0)?.[0];
  expect(typeof raw).toBe("string");
  return JSON.parse(String(raw)) as {
    valid: boolean;
    path: string;
    issues: Array<{
      path: string;
      message: string;
      allowedValues?: string[];
      allowedValuesHiddenCount?: number;
    }>;
  };
}

let registerConfigCli: typeof import("./config-cli.js").registerConfigCli;
let sharedProgram: Command;

async function runConfigCommand(args: string[]) {
  await sharedProgram.parseAsync(args, { from: "user" });
}

describe("config cli", () => {
  beforeAll(async () => {
    ({ registerConfigCli } = await import("./config-cli.js"));
    sharedProgram = new Command();
    sharedProgram.exitOverride();
    registerConfigCli(sharedProgram);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSecretRefValue.mockResolvedValue("resolved-secret");
  });

  describe("config set - issue #6070", () => {
    it("preserves existing config keys when setting a new value", async () => {
      const resolved: OpenClawConfig = {
        agents: {
          list: [{ id: "main" }, { id: "oracle", workspace: "~/oracle-workspace" }],
        },
        gateway: { port: 18789 },
        tools: { allow: ["group:fs"] },
        logging: { level: "debug" },
      };
      const runtimeMerged: OpenClawConfig = {
        ...withRuntimeDefaults(resolved),
      };
      setSnapshot(resolved, runtimeMerged);

      await runConfigCommand(["config", "set", "gateway.auth.mode", "token"]);

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = mockWriteConfigFile.mock.calls[0]?.[0];
      expect(written.gateway?.auth).toEqual({ mode: "token" });
      expect(written.gateway?.port).toBe(18789);
      expect(written.agents).toEqual(resolved.agents);
      expect(written.tools).toEqual(resolved.tools);
      expect(written.logging).toEqual(resolved.logging);
      expect(written.agents).not.toHaveProperty("defaults");
    });

    it("does not inject runtime defaults into the written config", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
      };
      const runtimeMerged = {
        ...resolved,
        agents: {
          defaults: {
            model: "gpt-5.2",
            contextWindow: 128_000,
            maxTokens: 16_000,
          },
        } as never,
        messages: { ackReaction: "✅" } as never,
        sessions: { persistence: { enabled: true } } as never,
      } as unknown as OpenClawConfig;
      setSnapshot(resolved, runtimeMerged);

      await runConfigCommand(["config", "set", "gateway.auth.mode", "token"]);

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = mockWriteConfigFile.mock.calls[0]?.[0];
      expect(written).not.toHaveProperty("agents.defaults.model");
      expect(written).not.toHaveProperty("agents.defaults.contextWindow");
      expect(written).not.toHaveProperty("agents.defaults.maxTokens");
      expect(written).not.toHaveProperty("messages.ackReaction");
      expect(written).not.toHaveProperty("sessions.persistence");
      expect(written.gateway?.port).toBe(18789);
      expect(written.gateway?.auth).toEqual({ mode: "token" });
    });

    it("auto-seeds a valid Ollama provider when setting only models.providers.ollama.apiKey", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
      };
      setSnapshot(resolved, resolved);

      await runConfigCommand(["config", "set", "models.providers.ollama.apiKey", '"ollama-local"']);

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = mockWriteConfigFile.mock.calls[0]?.[0];
      expect(written.models?.providers?.ollama).toEqual({
        baseUrl: "http://127.0.0.1:11434",
        api: "ollama",
        models: [],
        apiKey: "ollama-local", // pragma: allowlist secret
      });
    });
  });

  describe("config get", () => {
    it("redacts sensitive values", async () => {
      const resolved: OpenClawConfig = {
        gateway: {
          auth: {
            token: "super-secret-token",
          },
        },
      };
      setSnapshot(resolved, resolved);

      await runConfigCommand(["config", "get", "gateway.auth.token"]);

      expect(mockLog).toHaveBeenCalledWith("__OPENCLAW_REDACTED__");
    });
  });

  describe("config validate", () => {
    it("prints success and exits 0 when config is valid", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
      };
      setSnapshot(resolved, resolved);

      await runConfigCommand(["config", "validate"]);

      expect(mockExit).not.toHaveBeenCalled();
      expect(mockError).not.toHaveBeenCalled();
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("Config valid:"));
    });

    it("prints issues and exits 1 when config is invalid", async () => {
      setSnapshotOnce(
        makeInvalidSnapshot({
          issues: [
            {
              path: "agents.defaults.suppressToolErrorWarnings",
              message: "Unrecognized key(s) in object",
            },
          ],
        }),
      );

      await expect(runConfigCommand(["config", "validate"])).rejects.toThrow("__exit__:1");

      expect(mockError).toHaveBeenCalledWith(expect.stringContaining("Config invalid at"));
      expect(mockError).toHaveBeenCalledWith(
        expect.stringContaining("agents.defaults.suppressToolErrorWarnings"),
      );
      expect(mockLog).not.toHaveBeenCalled();
    });

    it("returns machine-readable JSON with --json for invalid config", async () => {
      setSnapshotOnce(
        makeInvalidSnapshot({
          issues: [{ path: "gateway.bind", message: "Invalid enum value" }],
        }),
      );

      const payload = await runValidateJsonAndGetPayload();
      expect(payload.valid).toBe(false);
      expect(payload.path).toBe("/tmp/custom-openclaw.json");
      expect(payload.issues).toEqual([{ path: "gateway.bind", message: "Invalid enum value" }]);
      expect(mockError).not.toHaveBeenCalled();
    });

    it("preserves allowed-values metadata in --json output", async () => {
      setSnapshotOnce(
        makeInvalidSnapshot({
          issues: [
            {
              path: "update.channel",
              message: 'Invalid input (allowed: "stable", "beta", "dev")',
              allowedValues: ["stable", "beta", "dev"],
              allowedValuesHiddenCount: 0,
            },
          ],
        }),
      );

      const payload = await runValidateJsonAndGetPayload();
      expect(payload.valid).toBe(false);
      expect(payload.path).toBe("/tmp/custom-openclaw.json");
      expect(payload.issues).toEqual([
        {
          path: "update.channel",
          message: 'Invalid input (allowed: "stable", "beta", "dev")',
          allowedValues: ["stable", "beta", "dev"],
        },
      ]);
      expect(mockError).not.toHaveBeenCalled();
    });

    it("prints file-not-found and exits 1 when config file is missing", async () => {
      setSnapshotOnce({
        path: "/tmp/openclaw.json",
        exists: false,
        raw: null,
        parsed: {},
        resolved: {},
        valid: true,
        config: {},
        issues: [],
        warnings: [],
        legacyIssues: [],
      });

      await expect(runConfigCommand(["config", "validate"])).rejects.toThrow("__exit__:1");
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining("Config file not found:"));
      expect(mockLog).not.toHaveBeenCalled();
    });
  });

  describe("config set parsing flags", () => {
    it("falls back to raw string when parsing fails and strict mode is off", async () => {
      const resolved: OpenClawConfig = { gateway: { port: 18789 } };
      setSnapshot(resolved, resolved);

      await runConfigCommand(["config", "set", "gateway.auth.mode", "{bad"]);

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = mockWriteConfigFile.mock.calls[0]?.[0];
      expect(written.gateway?.auth).toEqual({ mode: "{bad" });
    });

    it("throws when strict parsing is enabled via --strict-json", async () => {
      await expect(
        runConfigCommand(["config", "set", "gateway.auth.mode", "{bad", "--strict-json"]),
      ).rejects.toThrow("__exit__:1");

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expect(mockReadConfigFileSnapshot).not.toHaveBeenCalled();
    });

    it("keeps --json as a strict parsing alias", async () => {
      await expect(
        runConfigCommand(["config", "set", "gateway.auth.mode", "{bad", "--json"]),
      ).rejects.toThrow("__exit__:1");

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expect(mockReadConfigFileSnapshot).not.toHaveBeenCalled();
    });

    it("accepts --strict-json with batch mode and applies batch payload", async () => {
      const resolved: OpenClawConfig = { gateway: { port: 18789 } };
      setSnapshot(resolved, resolved);

      await runConfigCommand([
        "config",
        "set",
        "--batch-json",
        '[{"path":"gateway.auth.mode","value":"token"}]',
        "--strict-json",
      ]);

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = mockWriteConfigFile.mock.calls[0]?.[0];
      expect(written.gateway?.auth).toEqual({ mode: "token" });
    });

    it("shows --strict-json and keeps --json as a legacy alias in help", async () => {
      const program = new Command();
      registerConfigCli(program);

      const configCommand = program.commands.find((command) => command.name() === "config");
      const setCommand = configCommand?.commands.find((command) => command.name() === "set");
      const helpText = setCommand?.helpInformation() ?? "";

      expect(helpText).toContain("--strict-json");
      expect(helpText).toContain("--json");
      expect(helpText).toContain("Legacy alias for --strict-json");
      expect(helpText).toContain("--ref-provider");
      expect(helpText).toContain("--provider-source");
      expect(helpText).toContain("--batch-json");
      expect(helpText).toContain("--dry-run");
      expect(helpText).toContain("openclaw config set gateway.port 19001 --strict-json");
      expect(helpText).toContain(
        "openclaw config set channels.discord.token --ref-provider default --ref-source",
      );
      expect(helpText).toContain("--ref-id DISCORD_BOT_TOKEN");
      expect(helpText).toContain(
        "openclaw config set --batch-file ./config-set.batch.json --dry-run",
      );
    });
  });

  describe("config set builders and dry-run", () => {
    it("supports SecretRef builder mode without requiring a value argument", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
      };
      setSnapshot(resolved, resolved);

      await runConfigCommand([
        "config",
        "set",
        "channels.discord.token",
        "--ref-provider",
        "default",
        "--ref-source",
        "env",
        "--ref-id",
        "DISCORD_BOT_TOKEN",
      ]);

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = mockWriteConfigFile.mock.calls[0]?.[0];
      expect(written.channels?.discord?.token).toEqual({
        source: "env",
        provider: "default",
        id: "DISCORD_BOT_TOKEN",
      });
    });

    it("supports provider builder mode under secrets.providers.<alias>", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
      };
      setSnapshot(resolved, resolved);

      await runConfigCommand([
        "config",
        "set",
        "secrets.providers.vaultfile",
        "--provider-source",
        "file",
        "--provider-path",
        "/tmp/vault.json",
        "--provider-mode",
        "json",
      ]);

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = mockWriteConfigFile.mock.calls[0]?.[0];
      expect(written.secrets?.providers?.vaultfile).toEqual({
        source: "file",
        path: "/tmp/vault.json",
        mode: "json",
      });
    });

    it("runs resolvability checks in builder dry-run mode without writing", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      };
      setSnapshot(resolved, resolved);

      await runConfigCommand([
        "config",
        "set",
        "channels.discord.token",
        "--ref-provider",
        "default",
        "--ref-source",
        "env",
        "--ref-id",
        "DISCORD_BOT_TOKEN",
        "--dry-run",
      ]);

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expect(mockResolveSecretRefValue).toHaveBeenCalledTimes(1);
      expect(mockResolveSecretRefValue).toHaveBeenCalledWith(
        {
          source: "env",
          provider: "default",
          id: "DISCORD_BOT_TOKEN",
        },
        expect.objectContaining({
          env: expect.any(Object),
        }),
      );
    });

    it("requires schema validation in JSON dry-run mode", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
      };
      setSnapshot(resolved, resolved);

      await expect(
        runConfigCommand([
          "config",
          "set",
          "gateway.port",
          '"not-a-number"',
          "--strict-json",
          "--dry-run",
        ]),
      ).rejects.toThrow("__exit__:1");

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expect(mockError).toHaveBeenCalledWith(
        expect.stringContaining("Dry run failed: config schema validation failed."),
      );
    });

    it("logs a dry-run note when value mode performs no validation checks", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
      };
      setSnapshot(resolved, resolved);

      await runConfigCommand(["config", "set", "gateway.port", "19001", "--dry-run"]);

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expect(mockResolveSecretRefValue).not.toHaveBeenCalled();
      expect(mockLog).toHaveBeenCalledWith(
        expect.stringContaining(
          "Dry run note: value mode does not run schema/resolvability checks.",
        ),
      );
      expect(mockLog).toHaveBeenCalledWith(
        expect.stringContaining("Dry run successful: 1 update(s) validated"),
      );
    });

    it("supports batch mode for refs/providers in dry-run", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      };
      setSnapshot(resolved, resolved);

      await runConfigCommand([
        "config",
        "set",
        "--batch-json",
        '[{"path":"channels.discord.token","ref":{"source":"env","provider":"default","id":"DISCORD_BOT_TOKEN"}},{"path":"secrets.providers.default","provider":{"source":"env"}}]',
        "--dry-run",
      ]);

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expect(mockResolveSecretRefValue).toHaveBeenCalledTimes(1);
    });

    it("writes sibling SecretRef paths when target uses sibling-ref shape", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
        channels: {
          googlechat: {
            enabled: true,
          } as never,
        } as never,
      };
      setSnapshot(resolved, resolved);

      await runConfigCommand([
        "config",
        "set",
        "channels.googlechat.serviceAccount",
        "--ref-provider",
        "vaultfile",
        "--ref-source",
        "file",
        "--ref-id",
        "/providers/googlechat/serviceAccount",
      ]);

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = mockWriteConfigFile.mock.calls[0]?.[0];
      expect(written.channels?.googlechat?.serviceAccountRef).toEqual({
        source: "file",
        provider: "vaultfile",
        id: "/providers/googlechat/serviceAccount",
      });
      expect(written.channels?.googlechat?.serviceAccount).toBeUndefined();
    });

    it("rejects mixing ref-builder and provider-builder flags", async () => {
      await expect(
        runConfigCommand([
          "config",
          "set",
          "channels.discord.token",
          "--ref-provider",
          "default",
          "--ref-source",
          "env",
          "--ref-id",
          "DISCORD_BOT_TOKEN",
          "--provider-source",
          "env",
        ]),
      ).rejects.toThrow("__exit__:1");

      expect(mockError).toHaveBeenCalledWith(
        expect.stringContaining("config set mode error: choose exactly one mode"),
      );
    });

    it("rejects mixing batch mode with builder flags", async () => {
      await expect(
        runConfigCommand([
          "config",
          "set",
          "--batch-json",
          "[]",
          "--ref-provider",
          "default",
          "--ref-source",
          "env",
          "--ref-id",
          "DISCORD_BOT_TOKEN",
        ]),
      ).rejects.toThrow("__exit__:1");

      expect(mockError).toHaveBeenCalledWith(
        expect.stringContaining(
          "config set mode error: batch mode (--batch-json/--batch-file) cannot be combined",
        ),
      );
    });

    it("supports batch-file mode", async () => {
      const resolved: OpenClawConfig = { gateway: { port: 18789 } };
      setSnapshot(resolved, resolved);

      const pathname = path.join(
        os.tmpdir(),
        `openclaw-config-batch-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
      );
      fs.writeFileSync(pathname, '[{"path":"gateway.auth.mode","value":"token"}]', "utf8");
      try {
        await runConfigCommand(["config", "set", "--batch-file", pathname]);
      } finally {
        fs.rmSync(pathname, { force: true });
      }

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = mockWriteConfigFile.mock.calls[0]?.[0];
      expect(written.gateway?.auth).toEqual({ mode: "token" });
    });

    it("rejects malformed batch-file payloads", async () => {
      const pathname = path.join(
        os.tmpdir(),
        `openclaw-config-batch-invalid-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
      );
      fs.writeFileSync(pathname, '{"path":"gateway.auth.mode","value":"token"}', "utf8");
      try {
        await expect(runConfigCommand(["config", "set", "--batch-file", pathname])).rejects.toThrow(
          "__exit__:1",
        );
      } finally {
        fs.rmSync(pathname, { force: true });
      }

      expect(mockError).toHaveBeenCalledWith(
        expect.stringContaining("--batch-file must be a JSON array."),
      );
    });

    it("rejects malformed batch entries with mixed operation keys", async () => {
      await expect(
        runConfigCommand([
          "config",
          "set",
          "--batch-json",
          '[{"path":"channels.discord.token","value":"x","ref":{"source":"env","provider":"default","id":"DISCORD_BOT_TOKEN"}}]',
        ]),
      ).rejects.toThrow("__exit__:1");

      expect(mockError).toHaveBeenCalledWith(
        expect.stringContaining("must include exactly one of: value, ref, provider"),
      );
    });

    it("fails dry-run when a builder-assigned SecretRef is unresolved", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      };
      setSnapshot(resolved, resolved);
      mockResolveSecretRefValue.mockRejectedValueOnce(new Error("missing env var"));

      await expect(
        runConfigCommand([
          "config",
          "set",
          "channels.discord.token",
          "--ref-provider",
          "default",
          "--ref-source",
          "env",
          "--ref-id",
          "DISCORD_BOT_TOKEN",
          "--dry-run",
        ]),
      ).rejects.toThrow("__exit__:1");

      expect(mockError).toHaveBeenCalledWith(
        expect.stringContaining("Dry run failed: 1 SecretRef assignment(s) could not be resolved."),
      );
    });

    it("emits structured JSON for --dry-run --json success", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      };
      setSnapshot(resolved, resolved);

      await runConfigCommand([
        "config",
        "set",
        "channels.discord.token",
        "--ref-provider",
        "default",
        "--ref-source",
        "env",
        "--ref-id",
        "DISCORD_BOT_TOKEN",
        "--dry-run",
        "--json",
      ]);

      const raw = mockLog.mock.calls.at(-1)?.[0];
      expect(typeof raw).toBe("string");
      const payload = JSON.parse(String(raw)) as {
        ok: boolean;
        checks: { schema: boolean; resolvability: boolean };
        refsChecked: number;
        operations: number;
      };
      expect(payload.ok).toBe(true);
      expect(payload.operations).toBe(1);
      expect(payload.refsChecked).toBe(1);
      expect(payload.checks).toEqual({
        schema: false,
        resolvability: true,
      });
    });

    it("emits structured JSON for --dry-run --json failure", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      };
      setSnapshot(resolved, resolved);
      mockResolveSecretRefValue.mockRejectedValueOnce(new Error("missing env var"));

      await expect(
        runConfigCommand([
          "config",
          "set",
          "channels.discord.token",
          "--ref-provider",
          "default",
          "--ref-source",
          "env",
          "--ref-id",
          "DISCORD_BOT_TOKEN",
          "--dry-run",
          "--json",
        ]),
      ).rejects.toThrow("__exit__:1");

      const raw = mockLog.mock.calls.at(-1)?.[0];
      expect(typeof raw).toBe("string");
      const payload = JSON.parse(String(raw)) as {
        ok: boolean;
        errors?: Array<{ kind: string; message: string; ref?: string }>;
      };
      expect(payload.ok).toBe(false);
      expect(payload.errors?.some((entry) => entry.kind === "resolvability")).toBe(true);
      expect(
        payload.errors?.some((entry) => entry.ref?.includes("default:DISCORD_BOT_TOKEN")),
      ).toBe(true);
    });

    it("aggregates schema and resolvability failures in --dry-run --json mode", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      };
      setSnapshot(resolved, resolved);
      mockResolveSecretRefValue.mockRejectedValue(new Error("missing env var"));

      await expect(
        runConfigCommand([
          "config",
          "set",
          "--batch-json",
          '[{"path":"gateway.port","value":"not-a-number"},{"path":"channels.discord.token","ref":{"source":"env","provider":"default","id":"DISCORD_BOT_TOKEN"}}]',
          "--dry-run",
          "--json",
        ]),
      ).rejects.toThrow("__exit__:1");

      const raw = mockLog.mock.calls.at(-1)?.[0];
      expect(typeof raw).toBe("string");
      const payload = JSON.parse(String(raw)) as {
        ok: boolean;
        errors?: Array<{ kind: string; message: string; ref?: string }>;
      };
      expect(payload.ok).toBe(false);
      expect(payload.errors?.some((entry) => entry.kind === "schema")).toBe(true);
      expect(payload.errors?.some((entry) => entry.kind === "resolvability")).toBe(true);
      expect(
        payload.errors?.some((entry) => entry.ref?.includes("default:DISCORD_BOT_TOKEN")),
      ).toBe(true);
    });

    it("fails dry-run when provider updates make existing refs unresolvable", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
        secrets: {
          providers: {
            vaultfile: { source: "file", path: "/tmp/secrets.json", mode: "json" },
          },
        },
        tools: {
          web: {
            search: {
              enabled: true,
              apiKey: {
                source: "file",
                provider: "vaultfile",
                id: "/providers/search/apiKey",
              },
            },
          },
        } as never,
      };
      setSnapshot(resolved, resolved);
      mockResolveSecretRefValue.mockImplementationOnce(async () => {
        throw new Error("provider mismatch");
      });

      await expect(
        runConfigCommand([
          "config",
          "set",
          "secrets.providers.vaultfile",
          "--provider-source",
          "env",
          "--dry-run",
        ]),
      ).rejects.toThrow("__exit__:1");

      expect(mockError).toHaveBeenCalledWith(
        expect.stringContaining("Dry run failed: 1 SecretRef assignment(s) could not be resolved."),
      );
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining("provider mismatch"));
    });

    it("fails dry-run for nested provider edits that make existing refs unresolvable", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
        secrets: {
          providers: {
            vaultfile: { source: "file", path: "/tmp/secrets.json", mode: "json" },
          },
        },
        tools: {
          web: {
            search: {
              enabled: true,
              apiKey: {
                source: "file",
                provider: "vaultfile",
                id: "/providers/search/apiKey",
              },
            },
          },
        } as never,
      };
      setSnapshot(resolved, resolved);
      mockResolveSecretRefValue.mockImplementationOnce(async () => {
        throw new Error("provider mismatch");
      });

      await expect(
        runConfigCommand([
          "config",
          "set",
          "secrets.providers.vaultfile.path",
          '"/tmp/other-secrets.json"',
          "--strict-json",
          "--dry-run",
        ]),
      ).rejects.toThrow("__exit__:1");

      expect(mockResolveSecretRefValue).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "vaultfile",
          id: "/providers/search/apiKey",
        }),
        expect.any(Object),
      );
      expect(mockError).toHaveBeenCalledWith(
        expect.stringContaining("Dry run failed: 1 SecretRef assignment(s) could not be resolved."),
      );
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining("provider mismatch"));
    });
  });

  describe("path hardening", () => {
    it("rejects blocked prototype-key segments for config get", async () => {
      await expect(runConfigCommand(["config", "get", "gateway.__proto__.token"])).rejects.toThrow(
        "Invalid path segment: __proto__",
      );

      expect(mockReadConfigFileSnapshot).not.toHaveBeenCalled();
      expect(mockWriteConfigFile).not.toHaveBeenCalled();
    });

    it("rejects blocked prototype-key segments for config set", async () => {
      await expect(
        runConfigCommand(["config", "set", "tools.constructor.profile", '"sandbox"']),
      ).rejects.toThrow("Invalid path segment: constructor");

      expect(mockReadConfigFileSnapshot).not.toHaveBeenCalled();
      expect(mockWriteConfigFile).not.toHaveBeenCalled();
    });

    it("rejects blocked prototype-key segments for config unset", async () => {
      await expect(
        runConfigCommand(["config", "unset", "channels.prototype.enabled"]),
      ).rejects.toThrow("Invalid path segment: prototype");

      expect(mockReadConfigFileSnapshot).not.toHaveBeenCalled();
      expect(mockWriteConfigFile).not.toHaveBeenCalled();
    });
  });

  describe("config unset - issue #6070", () => {
    it("preserves existing config keys when unsetting a value", async () => {
      const resolved: OpenClawConfig = {
        agents: { list: [{ id: "main" }] },
        gateway: { port: 18789 },
        tools: {
          profile: "coding",
          alsoAllow: ["agents_list"],
        },
        logging: { level: "debug" },
      };
      const runtimeMerged: OpenClawConfig = {
        ...withRuntimeDefaults(resolved),
      };
      setSnapshot(resolved, runtimeMerged);

      await runConfigCommand(["config", "unset", "tools.alsoAllow"]);

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = mockWriteConfigFile.mock.calls[0]?.[0];
      expect(written.tools).not.toHaveProperty("alsoAllow");
      expect(written.agents).not.toHaveProperty("defaults");
      expect(written.agents?.list).toEqual(resolved.agents?.list);
      expect(written.gateway).toEqual(resolved.gateway);
      expect(written.tools?.profile).toBe("coding");
      expect(written.logging).toEqual(resolved.logging);
      expect(mockWriteConfigFile.mock.calls[0]?.[1]).toEqual({
        unsetPaths: [["tools", "alsoAllow"]],
      });
    });
  });

  describe("config file", () => {
    it("prints the active config file path", async () => {
      const resolved: OpenClawConfig = { gateway: { port: 18789 } };
      setSnapshot(resolved, resolved);

      await runConfigCommand(["config", "file"]);

      expect(mockLog).toHaveBeenCalledWith("/tmp/openclaw.json");
      expect(mockWriteConfigFile).not.toHaveBeenCalled();
    });

    it("handles config file path with home directory", async () => {
      const resolved: OpenClawConfig = { gateway: { port: 18789 } };
      const snapshot = buildSnapshot({ resolved, config: resolved });
      snapshot.path = "/home/user/.openclaw/openclaw.json";
      mockReadConfigFileSnapshot.mockResolvedValueOnce(snapshot);

      await runConfigCommand(["config", "file"]);

      expect(mockLog).toHaveBeenCalledWith("/home/user/.openclaw/openclaw.json");
    });
  });
});
