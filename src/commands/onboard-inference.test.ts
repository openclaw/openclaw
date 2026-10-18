// Passive discovery preserves candidate order without running native login flows.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as cliCredentials from "../agents/cli-credentials.js";
import * as facadeRuntime from "../plugin-sdk/facade-runtime.js";
import * as probes from "../system-agent/probes.js";
import {
  ANTHROPIC_API_DEFAULT_MODEL_REF,
  CLAUDE_CLI_DEFAULT_MODEL_REF,
  detectInferenceBackends,
} from "./onboard-inference.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const geminiCredential: cliCredentials.GeminiCliCredential = {
  type: "oauth",
  provider: "google-gemini-cli",
  access: "synthetic-access",
  refresh: "synthetic-refresh",
  expires: 1,
};

const emptyPluginMetadataSnapshot = vi.hoisted(() => ({
  policyHash: "onboard-inference-test-empty-plugin-policy",
  configFingerprint: "onboard-inference-test-empty-plugin-metadata",
  index: {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "onboard-inference-test-empty-plugin-policy",
    generatedAtMs: 0,
    installRecords: {},
    plugins: [],
    diagnostics: [],
  },
  registryDiagnostics: [],
  manifestRegistry: { plugins: [], diagnostics: [] },
  plugins: [],
  diagnostics: [],
  byPluginId: new Map(),
  normalizePluginId: (pluginId: string) => pluginId,
  owners: {
    channels: new Map(),
    channelConfigs: new Map(),
    providers: new Map(),
    modelCatalogProviders: new Map(),
    cliBackends: new Map(),
    setupProviders: new Map(),
    commandAliases: new Map(),
    contracts: new Map(),
    providerAuthContributions: [],
    modelIdNormalizationPolicies: new Map(),
  },
  metrics: {
    registrySnapshotMs: 0,
    manifestRegistryMs: 0,
    ownerMapsMs: 0,
    totalMs: 0,
    indexPluginCount: 0,
    manifestPluginCount: 0,
  },
}));

vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: () => emptyPluginMetadataSnapshot,
}));

afterAll(() => {
  vi.doUnmock("../plugins/current-plugin-metadata-snapshot.js");
  vi.resetModules();
});

beforeEach(() => {
  for (const key of [
    "USERPROFILE",
    "OPENCLAW_HOME",
    "CODEX_HOME",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
  ]) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv("HOME", tempDirs.make("openclaw-onboard-inference-"));
  vi.spyOn(os, "homedir").mockImplementation(() => process.env.HOME ?? "");
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.spyOn(probes, "probeLocalCommand").mockImplementation(probeDeps({}));
  vi.spyOn(cliCredentials, "hasCodexCliAuthFile").mockReturnValue(false);
  vi.spyOn(cliCredentials, "readGeminiCliCredentialsCached").mockReturnValue(null);
  vi.spyOn(facadeRuntime, "tryLoadActivatedBundledPluginPublicSurfaceModule").mockResolvedValue(
    null,
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function probeDeps(found: Record<string, boolean>) {
  return async (command: string): Promise<probes.LocalCommandProbe> => ({
    command,
    found: found[command] ?? false,
  });
}

describe("detectInferenceBackends", () => {
  it.each([false, true])(
    "keeps native detection passive with stored Codex credentials: %s",
    async (stored) => {
      const calls: Array<{ command: string; args: string[] }> = [];
      vi.mocked(probes.probeLocalCommand).mockImplementation(
        async (command, args = ["--version"]) => {
          calls.push({ command, args });
          return { command, found: command === "codex" || command === "claude" };
        },
      );
      vi.mocked(cliCredentials.hasCodexCliAuthFile).mockReturnValue(stored);
      const candidates = await detectInferenceBackends();
      expect(facadeRuntime.tryLoadActivatedBundledPluginPublicSurfaceModule).not.toHaveBeenCalled();
      expect(calls.every(({ args }) => args.length === 1 && args[0] === "--version")).toBe(true);
      expect(candidates).toMatchObject([
        { kind: "claude-cli", detail: "installed; login status unverified" },
        {
          kind: "codex-cli",
          detail: stored
            ? "installed; stored credentials found; login status unverified"
            : "installed; login status unverified",
          credentials: stored,
        },
      ]);
      expect(candidates[0]?.credentials).toBeUndefined();
    },
  );

  it.each([
    ["home", "chatgpt"],
    ["codex-home", "chatgpt"],
    ["codex-home", "apikey"],
  ] as const)(
    "detects the %s login file for %s without reading credential values",
    async (selection, authMode) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-passive-login-"));
      try {
        const selectedHome = path.join(root, "selected");
        const codexHome =
          selection === "home" ? path.join(selectedHome, ".codex") : path.join(root, "override");
        await fs.mkdir(codexHome, { recursive: true });
        const authPath = path.join(codexHome, "auth.json");
        const raw = JSON.stringify({
          auth_mode: authMode,
          ...(authMode === "apikey" ? { OPENAI_API_KEY: "synthetic-api-key" } : {}),
          tokens: {
            access_token: "synthetic-access",
            refresh_token: "synthetic-refresh",
          },
        });
        await fs.writeFile(authPath, raw);
        vi.stubEnv("HOME", selectedHome);
        vi.stubEnv("CODEX_HOME", selection === "codex-home" ? codexHome : undefined);
        vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
        vi.mocked(probes.probeLocalCommand).mockImplementation(probeDeps({ codex: true }));
        vi.mocked(cliCredentials.hasCodexCliAuthFile).mockRestore();
        const candidates = await detectInferenceBackends();
        expect(candidates).toMatchObject([
          {
            kind: "codex-cli",
            detail: "installed; stored credentials found; login status unverified",
          },
        ]);
        expect(candidates[0]?.credentials).toBe(true);
        expect(await fs.readFile(authPath, "utf8")).toBe(raw);
        expect(JSON.stringify(candidates)).not.toContain("synthetic-");
        expect(
          facadeRuntime.tryLoadActivatedBundledPluginPublicSurfaceModule,
        ).not.toHaveBeenCalled();
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("reports a timed-out Codex probe instead of treating Codex as absent", async () => {
    vi.mocked(probes.probeLocalCommand).mockImplementation(async (command) => ({
      command,
      found: true,
      timedOut: true,
      error: "timed out after 1500ms",
    }));
    const detection = detectInferenceBackends();

    await expect(detection).rejects.toThrow(
      "Codex detection failed (codex): timed out after 1500ms",
    );
  });

  it.each(["linux", "darwin"] as const)(
    "reports failed Codex execution during %s discovery",
    async (platform) => {
      const probe = vi.fn(async (command: string): Promise<probes.LocalCommandProbe> => ({
        command,
        found: false,
        ...(command === "codex"
          ? { failure: "error", error: "Operation not permitted" }
          : { failure: "not-found" }),
      }));
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      vi.mocked(probes.probeLocalCommand).mockImplementation(probe);
      await expect(detectInferenceBackends()).rejects.toThrow(
        "Codex detection failed (codex): Operation not permitted",
      );
      expect(probe.mock.calls.map(([command]) => command)).toEqual(["claude", "codex", "gemini"]);
    },
  );

  it("reports a failed macOS bundled Codex probe instead of treating it as absent", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.mocked(probes.probeLocalCommand).mockImplementation(async (command) => ({
      command,
      found: false,
      failure: command.startsWith("/Applications/") ? "error" : "not-found",
      error: command.startsWith("/Applications/") ? "Operation not permitted" : "not found",
    }));
    await expect(detectInferenceBackends()).rejects.toThrow(
      "Codex detection failed (/Applications/ChatGPT.app/Contents/Resources/codex): Operation not permitted",
    );
  });

  it("reports inaccessible Codex sign-in state instead of treating the login as absent", async () => {
    vi.mocked(probes.probeLocalCommand).mockImplementation(probeDeps({ codex: true }));
    vi.mocked(cliCredentials.hasCodexCliAuthFile).mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });
    await expect(detectInferenceBackends()).rejects.toThrow(
      "Codex sign-in detection failed: EACCES: permission denied",
    );
  });

  it("keeps a genuinely missing Codex executable and login absent", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    expect(await detectInferenceBackends()).toEqual([]);
  });

  it("orders discovery: existing model, environment keys, then unverified CLIs", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-x");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-y");
    vi.mocked(probes.probeLocalCommand).mockImplementation(
      probeDeps({ claude: true, codex: true, gemini: true }),
    );
    vi.mocked(cliCredentials.hasCodexCliAuthFile).mockReturnValue(true);
    vi.mocked(cliCredentials.readGeminiCliCredentialsCached).mockReturnValue(geminiCredential);
    const candidates = await detectInferenceBackends({
      config: {
        agents: {
          defaults: { model: "zai/glm-5.2" },
          entries: { main: {} },
        },
      },
    });
    expect(candidates.map((candidate) => candidate.kind)).toEqual([
      "existing-model",
      "openai-api-key",
      "anthropic-api-key",
      "claude-cli",
      "codex-cli",
      "gemini-cli",
    ]);
    expect(candidates[0]?.modelRef).toBe("zai/glm-5.2");
    expect(candidates[0]?.detail).toBe("zai/glm-5.2 — already configured");
    expect(candidates[1]?.modelRef).toBe("openai/gpt-6-astra");
    expect(candidates[2]?.modelRef).toBe(ANTHROPIC_API_DEFAULT_MODEL_REF);
    expect(candidates[3]?.modelRef).toBe(CLAUDE_CLI_DEFAULT_MODEL_REF);
    expect(candidates[4]?.modelRef).toBe("openai/gpt-6-astra");
  });

  it("keeps an Anthropic environment key ahead of unknown Claude status", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-y");
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.mocked(probes.probeLocalCommand).mockImplementation(probeDeps({ claude: true }));
    const candidates = await detectInferenceBackends();

    expect(candidates.map((candidate) => candidate.kind)).toEqual([
      "anthropic-api-key",
      "claude-cli",
    ]);
    expect(candidates[1]?.credentials).toBeUndefined();
  });

  it("prefers the explicitly selected agent model over the global default", async () => {
    const candidates = await detectInferenceBackends({
      config: {
        agents: {
          ownership: "explicit",
          defaults: { model: "openai/gpt-5.5" },
          entries: {
            fallback: { model: "google/gemini-3.1-pro-preview" },
            ops: { model: "anthropic/claude-opus-4-8" },
          },
        },
      },
      agentId: "ops",
    });

    expect(candidates).toMatchObject([
      { kind: "existing-model", modelRef: "anthropic/claude-opus-4-8" },
    ]);
  });

  it("captures the canonical target for an authored model alias", async () => {
    const candidates = await detectInferenceBackends({
      config: {
        agents: {
          defaults: {
            model: { primary: "opus" },
            models: { "anthropic/claude-opus-4-8": { alias: "opus" } },
          },
          entries: { main: {} },
        },
      },
    });

    expect(candidates).toMatchObject([
      { kind: "existing-model", modelRef: "anthropic/claude-opus-4-8" },
    ]);
  });

  it("keeps missing Gemini legacy credentials and native login states unverified", async () => {
    vi.mocked(probes.probeLocalCommand).mockImplementation(
      probeDeps({ claude: true, codex: true, gemini: true }),
    );
    const candidates = await detectInferenceBackends();

    expect(candidates).toMatchObject([
      { kind: "claude-cli", detail: "installed; login status unverified" },
      { kind: "codex-cli", detail: "installed; login status unverified" },
      { kind: "gemini-cli", detail: "installed; login status unavailable" },
    ]);
    expect(
      candidates.find((candidate) => candidate.kind === "gemini-cli")?.credentials,
    ).toBeUndefined();
  });

  it("offers stored Codex credentials when its runtime still needs installation", async () => {
    vi.mocked(probes.probeLocalCommand).mockImplementation(probeDeps({ claude: true }));
    vi.mocked(cliCredentials.hasCodexCliAuthFile).mockReturnValue(true);
    const candidates = await detectInferenceBackends();

    expect(candidates).toMatchObject([
      { kind: "claude-cli" },
      {
        kind: "codex-cli",
        credentials: true,
        detail: "stored credentials found; runtime installation required",
      },
    ]);
  });

  it("only checks the version of a Codex executable discovered in a macOS app", async () => {
    const command = "/Applications/ChatGPT.app/Contents/Resources/codex";
    const probed: Array<{ command: string; args: string[]; timeoutMs?: number }> = [];
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.mocked(probes.probeLocalCommand).mockImplementation(
      async (probedCommand, args = ["--version"], opts = {}) => {
        probed.push({ command: probedCommand, args, timeoutMs: opts.timeoutMs });
        return {
          command: probedCommand,
          found: probedCommand === command,
          ...(args[0] === "login" ? { version: "Not logged in", error: "exited 1" } : {}),
        };
      },
    );
    const candidates = await detectInferenceBackends();

    expect(candidates).toMatchObject([
      { kind: "codex-cli", detail: "installed; login status unverified" },
    ]);
    expect(candidates[0]?.credentials).toBe(false);
    expect(probed).toContainEqual({ command, args: ["--version"], timeoutMs: 3_000 });
    expect(probed.filter((entry) => entry.command === command)).toEqual([
      { command, args: ["--version"], timeoutMs: 3_000 },
    ]);
  });
});
