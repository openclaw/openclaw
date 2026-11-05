/** Tests secrets audit reporting and remediation hints. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthProfileStoreFixture } from "../agents/auth-profiles/credential-fixtures.test-support.js";
import {
  noteCommittedSharedAuthStoreOwnership,
  resolveSharedAuthStorePath,
} from "../agents/auth-profiles/path-resolve.js";
import {
  resolveAuthProfileDatabasePath,
  writePersistedAuthProfileStoreRaw,
} from "../agents/auth-profiles/sqlite.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  createApplyFixture,
  createOpenAiProviderConfig,
  OPENAI_API_KEY_ENV_REF as ENV_REF,
  writeJsonFile,
} from "./apply.test-support.js";
import { runSecretsAudit } from "./audit.js";
import { describeSecretResolutionError } from "./resolve-errors.js";
import { resolveSecretRefString } from "./resolve.js";
import { isRetryableSecretDegradationReason } from "./runtime-degraded-state.js";
import { writeSecretStoreEntry } from "./store/secret-store.js";

type AuditFixture = Awaited<ReturnType<typeof createAuditFixture>>;

const OPENAI_API_KEY_MARKER = ENV_REF.id;

function modelProvider(apiKey: unknown = ENV_REF, extra: Record<string, unknown> = {}) {
  return { ...createOpenAiProviderConfig(apiKey), ...extra };
}

function writeAuthStore(fixture: AuditFixture, value: unknown): void {
  writePersistedAuthProfileStoreRaw(value, fixture.agentDir);
}

const storeRef = { source: "store", provider: "default", id: "STORED_API_KEY" } as const;

const execRef = (id: string) => ({ source: "exec", provider: "execmain", id });
const authProfile = (key: string, keyRef?: unknown) => ({
  type: "api_key",
  provider: "openai",
  key,
  ...(keyRef ? { keyRef } : {}),
});
const modelsConfig = (openai: ReturnType<typeof modelProvider>) => ({
  models: { providers: { openai } },
});

function expectFinding(
  report: Awaited<ReturnType<typeof runSecretsAudit>>,
  match: { code?: string; file?: string; jsonPath?: string },
  present = true,
) {
  const finding = [expect.objectContaining(match)];
  expect(report.findings).toEqual(
    present ? expect.arrayContaining(finding) : expect.not.arrayContaining(finding),
  );
}

const expectPathMissing = (filePath: string) =>
  expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });

async function createAuditFixture() {
  const fixture = await createApplyFixture(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-audit-")),
  );
  const env: NodeJS.ProcessEnv = {
    ...fixture.env,
    OPENAI_API_KEY: "env-openai-key", // pragma: allowlist secret
    PATH: process.env.PATH?.trim() ? process.env.PATH : "/usr/bin:/bin",
  };
  return {
    ...fixture,
    modelsPath: path.join(fixture.agentDir, "models.json"),
    env,
  };
}

async function seedAuditFixture(fixture: AuditFixture): Promise<void> {
  await writeJsonFile(fixture.configPath, modelsConfig(modelProvider()));
  writeAuthStore(fixture, {
    version: 1,
    profiles: {
      "openai:default": { type: "api_key", provider: "openai", key: "sk-openai-plaintext" },
    },
  });
  await writeJsonFile(fixture.modelsPath, {
    providers: { openai: modelProvider(OPENAI_API_KEY_MARKER) },
  });
  await fs.writeFile(
    fixture.envPath,
    `${OPENAI_API_KEY_MARKER}=sk-openai-plaintext\n`, // pragma: allowlist secret
    "utf8",
  );
}

describe("secrets audit", () => {
  let fixture: AuditFixture;
  const audit = (allowExec = false) => runSecretsAudit({ env: fixture.env, allowExec });
  const writeConfig = (config: unknown) => writeJsonFile(fixture.configPath, config);
  const writeStoredSecret = (value: string) =>
    writeSecretStoreEntry({
      scope: { kind: "team" },
      name: storeRef.id,
      value,
      kind: "secret",
      updatedBy: "test",
      database: { env: fixture.env },
    });

  async function writeModelsProvider(
    overrides: { apiKey?: unknown; headers?: Record<string, unknown> } = {},
  ) {
    await writeJsonFile(fixture.modelsPath, {
      providers: { openai: modelProvider(OPENAI_API_KEY_MARKER, overrides) },
    });
  }

  async function execFixture({ header = false, fail = false } = {}) {
    const logPath = path.join(fixture.rootDir, "exec-calls.log");
    const scriptPath = path.join(fixture.rootDir, fail ? "resolver.mjs" : "resolver.sh");
    const headerId = "providers/openai/headers/Authorization";
    const values = {
      "providers/openai/apiKey": "value:providers/openai/apiKey",
      ...(header ? { [headerId]: `value:${headerId}` } : {}),
    };
    const lines = fail
      ? [
          "#!/usr/bin/env node",
          "import fs from 'node:fs';",
          `fs.appendFileSync(${JSON.stringify(logPath)}, 'x\\n');`,
          "process.exit(1);",
        ]
      : [
          "#!/bin/sh",
          `printf 'x\\n' >> ${JSON.stringify(logPath)}`,
          "cat >/dev/null",
          `printf '${JSON.stringify({ protocolVersion: 1, values }).replaceAll("'", "'\\''")}'`,
        ];
    await fs.writeFile(scriptPath, lines.join("\n"), { encoding: "utf8", mode: 0o700 });
    await writeConfig({
      secrets: {
        providers: {
          execmain: {
            source: "exec",
            command: scriptPath,
            jsonOnly: true,
            ...(fail ? { passEnv: ["PATH"] } : { timeoutMs: 20_000, noOutputTimeoutMs: 10_000 }),
          },
        },
      },
      ...modelsConfig(
        modelProvider(
          execRef("providers/openai/apiKey"),
          header ? { headers: { Authorization: execRef(headerId) } } : {},
        ),
      ),
    });
    return logPath;
  }

  async function expectOneExecution(logPath: string) {
    expect(
      (await fs.readFile(logPath, "utf8")).split("\n").filter((line) => line.trim()).length,
    ).toBe(1);
  }

  function expectModelsFinding(
    report: Awaited<ReturnType<typeof runSecretsAudit>>,
    code: string,
    jsonPath?: string,
    present = true,
  ) {
    expectFinding(
      report,
      { code, file: fixture.modelsPath, ...(jsonPath ? { jsonPath } : {}) },
      present,
    );
  }

  beforeEach(async () => {
    fixture = await createAuditFixture();
    await writeConfig({});
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    await fs.rm(fixture.rootDir, { recursive: true, force: true });
  });

  describe("store SecretRef resolution", () => {
    const config = (alias: string, source: "env" | "store") => ({
      secrets: { providers: { [alias]: { source } } },
    });
    const resolve = (provider = "default", configuredSource: "env" | "store" = "store") =>
      resolveSecretRefString(
        { ...storeRef, provider },
        { config: config(provider, configuredSource), env: fixture.env },
      );

    it.each([
      ["default", "env"],
      ["teamstore", "store"],
    ] as const)("resolves store alias %s configured as %s", async (provider, source) => {
      await writeStoredSecret("resolved-store-secret");
      await expect(resolve(provider, source)).resolves.toBe("resolved-store-secret");
    });
    it("rejects a non-default store alias configured for another source", async () => {
      await expect(resolve("envmain", "env")).rejects.toMatchObject({
        code: "SECRET_PROVIDER_INVALID",
        source: "store",
        provider: "envmain",
      });
    });
    it("resolves the env default when a store provider uses the same alias", async () => {
      await expect(
        resolveSecretRefString(ENV_REF, { config: config("default", "store"), env: fixture.env }),
      ).resolves.toBe("env-openai-key");
    });
    it("maps a missing name to a retryable not-found degradation", async () => {
      const error = await resolveSecretRefString(
        { ...storeRef, id: "MISSING_API_KEY" },
        { config: {}, env: fixture.env },
      ).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "SECRET_REF_NOT_FOUND", source: "store" });
      const reason = describeSecretResolutionError(error);
      expect(reason).toBe("secret reference was not found");
      expect(isRetryableSecretDegradationReason(reason ?? "")).toBe(true);
    });
    it("maps database access failures to provider unavailable", async () => {
      fixture.env.OPENCLAW_STATE_DIR = path.join(fixture.rootDir, "not-a-directory");
      await fs.writeFile(fixture.env.OPENCLAW_STATE_DIR, "not a directory", "utf8");
      const error = await resolveSecretRefString(storeRef, { config: {}, env: fixture.env }).catch(
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({ code: "SECRET_PROVIDER_UNAVAILABLE", source: "store" });
      expect(describeSecretResolutionError(error)).toBe("secret provider failed");
    });
  });

  it("reports plaintext + shadowing findings", async () => {
    await seedAuditFixture(fixture);
    const report = await audit();
    expect(report.status).toBe("findings");
    expect(report.summary.plaintextCount).toBeGreaterThan(0);
    expect(report.summary.shadowedRefCount).toBeGreaterThan(0);
    expectFinding(report, { code: "REF_SHADOWED" });
    expectFinding(report, { code: "PLAINTEXT_FOUND" });
  });

  it("audits inactive Talk speech and realtime provider references independently", async () => {
    const providerSelection = (missingKey: string) => ({
      provider: "openai",
      providers: {
        openai: { apiKey: ENV_REF },
        inactive: { apiKey: { source: "env", provider: "default", id: missingKey } },
      },
    });
    await writeConfig({
      talk: {
        ...providerSelection("MISSING_TALK_SPEECH_KEY"),
        realtime: providerSelection("MISSING_TALK_REALTIME_KEY"),
      },
    });

    const report = await audit();
    expect(
      report.findings
        .filter((finding) => finding.code === "REF_UNRESOLVED")
        .map((finding) => finding.jsonPath)
        .toSorted(),
    ).toEqual(["talk.providers.inactive.apiKey", "talk.realtime.providers.inactive.apiKey"]);
  });

  it("reports plaintext that duplicates the store while resolving store refs", async () => {
    await writeStoredSecret("shared-store-value");
    await writeConfig({
      models: {
        providers: {
          plaintext: modelProvider("shared-store-value"),
          referenced: modelProvider(storeRef),
          envReferenced: modelProvider("${AUDIT_STORE_VALUE}"),
        },
      },
    });

    const report = await runSecretsAudit({
      env: { ...fixture.env, AUDIT_STORE_VALUE: "shared-store-value" },
    });
    expect(report.summary.storeResidueCount).toBe(1);
    expect(report.findings.find((entry) => entry.code === "STORE_PLAINTEXT_RESIDUE")).toMatchObject(
      {
        jsonPath: "models.providers.plaintext.apiKey",
        message: expect.stringContaining("STORED_API_KEY"),
      },
    );
    expectFinding(
      report,
      { code: "REF_UNRESOLVED", jsonPath: "models.providers.referenced.apiKey" },
      false,
    );
  });

  it.each(["", ".migrated-2026-07-25T12-00-00.000Z-fake", ".sqlite-import.1753430400000.bak"])(
    "reports auth.json%s without inspecting or mutating it",
    async (suffix) => {
      const filePath = `${fixture.authJsonPath}${suffix}`;
      await fs.writeFile(filePath, "{invalid-json", "utf8");
      const report = await audit();
      expectFinding(report, { code: "LEGACY_RESIDUE" });
      expectFinding(report, { file: filePath });
      expect(report.filesScanned).not.toContain(filePath);
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("{invalid-json");
      await expectPathMissing(fixture.authStorePath);
    },
  );

  it.each(["denied", "allowed", "provider failure"] as const)("exec audit: %s", async (mode) => {
    if (process.platform === "win32") {
      return;
    }
    const allowed = mode !== "denied";
    const failed = mode === "provider failure";
    const execLogPath = await execFixture({ header: allowed, fail: failed });
    const report = await audit(allowed);
    if (failed) {
      expect(report.summary.unresolvedRefCount).toBeGreaterThanOrEqual(2);
    } else {
      expect(report.summary.unresolvedRefCount).toBe(0);
    }
    if (allowed) {
      if (!failed) {
        expect(report.resolution.refsChecked).toBe(2);
      }
      await expectOneExecution(execLogPath);
    } else {
      expect(report.resolution).toMatchObject({ resolvabilityComplete: false, skippedExecRefs: 1 });
      await expectPathMissing(execLogPath);
    }
  });

  it("scans hardlinked agent models.json files for plaintext provider apiKey values", async () => {
    await writeModelsProvider({ apiKey: "sk-models-plaintext" }); // pragma: allowlist secret
    await fs.link(fixture.modelsPath, path.join(fixture.rootDir, "models-alias.json"));

    const report = await audit();
    expectModelsFinding(report, "PLAINTEXT_FOUND", "providers.openai.apiKey");
    expectModelsFinding(report, "REF_UNRESOLVED", undefined, false);
    expect(report.filesScanned).toContain(fixture.modelsPath);
  });

  it.each([
    ["PLAINTEXT_FOUND", "Bearer sk-header-plaintext"], // pragma: allowlist secret
    ["REF_UNRESOLVED", { ...ENV_REF, id: "OPENAI_HEADER_TOKEN" }], // pragma: allowlist secret
  ] as const)("reports %s for models.json provider headers", async (code, Authorization) => {
    await writeModelsProvider({ headers: { Authorization } });
    expectModelsFinding(await audit(), code, "providers.openai.headers.Authorization");
  });

  it("reports malformed models.json as unresolved findings", async () => {
    const payloadMarker = "audit-raw";
    await fs.writeFile(fixture.modelsPath, payloadMarker, "utf8");
    const report = await audit();
    expectModelsFinding(report, "REF_UNRESOLVED");
    expect(JSON.stringify(report)).not.toContain(payloadMarker);
  });

  it("ignores models.json with a null root", async () => {
    await writeJsonFile(fixture.modelsPath, null);
    const report = await audit();
    expectModelsFinding(report, "REF_UNRESOLVED", undefined, false);
    expectModelsFinding(report, "PLAINTEXT_FOUND", undefined, false);
    expect(report.filesScanned).toContain(fixture.modelsPath);
  });

  it.runIf(process.platform !== "win32")(
    "reports symlinked models.json with a present target as unresolved findings",
    async () => {
      await writeModelsProvider({ apiKey: "linked-models-fixture" });
      const target = path.join(fixture.rootDir, "models-target.json");
      await fs.rename(fixture.modelsPath, target);
      await fs.symlink(target, fixture.modelsPath);

      const report = await audit();
      expectModelsFinding(report, "REF_UNRESOLVED");
      expectModelsFinding(report, "PLAINTEXT_FOUND", undefined, false);
      expect(report.filesScanned).toContain(fixture.modelsPath);
    },
  );

  it("scans active agent-dir override models.json even when outside state dir", async () => {
    const externalAgentDir = path.join(fixture.rootDir, "external-agent");
    const externalModelsPath = path.join(externalAgentDir, "models.json");
    await fs.mkdir(externalAgentDir, { recursive: true });
    await writeJsonFile(externalModelsPath, {
      providers: { openai: modelProvider("sk-external-plaintext") },
    }); // pragma: allowlist secret

    const report = await runSecretsAudit({
      env: {
        ...fixture.env,
        OPENCLAW_AGENT_DIR: externalAgentDir,
      },
    });
    expectFinding(report, {
      code: "PLAINTEXT_FOUND",
      file: externalModelsPath,
      jsonPath: "providers.openai.apiKey",
    });
    expect(report.filesScanned).toContain(externalModelsPath);
  });

  it("classifies auth profile env shorthands as refs with or without explicit keyRef", async () => {
    const keyRef = { source: "env", id: "OPENAI_API_KEY" };
    writeAuthStore(fixture, {
      version: 1,
      profiles: {
        "openai:dollar": authProfile("$OPENAI_API_KEY"), // pragma: allowlist secret
        "openai:braced": authProfile("${OPENAI_API_KEY}"), // pragma: allowlist secret
        "openai:dollar-with-ref": authProfile("$OPENAI_API_KEY", keyRef), // pragma: allowlist secret
        "openai:braced-with-ref": authProfile("${OPENAI_API_KEY}", keyRef), // pragma: allowlist secret
        "openai:plaintext-with-ref": authProfile("sk-leftover-plaintext", keyRef), // pragma: allowlist secret
      },
    });

    const report = await audit();
    const authPlaintextPaths = report.findings
      .filter((entry) => entry.code === "PLAINTEXT_FOUND" && entry.file === fixture.authStorePath)
      .map((entry) => entry.jsonPath);
    expect(authPlaintextPaths).toEqual(["profiles.openai:plaintext-with-ref.key"]);
  });

  it("reads a relocated shared store from the explicitly routed state root", async () => {
    const ambientStateDir = path.join(fixture.rootDir, "ambient-state");
    const ambientAgentDir = path.join(ambientStateDir, "agents", "main", "agent");
    vi.stubEnv("OPENCLAW_STATE_DIR", ambientStateDir);
    writePersistedAuthProfileStoreRaw(
      createAuthProfileStoreFixture({
        "openai:ambient": authProfile("sk-ambient-plaintext"),
      }),
      ambientAgentDir,
    );
    const insert = openOpenClawStateDatabase({ env: fixture.env }).db.prepare(
      "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, 1)",
    );
    insert.run("auth.sharedStore", JSON.stringify({ location: "state-db" }));
    insert.run(
      "authProfiles.store",
      JSON.stringify(
        createAuthProfileStoreFixture({
          "openai:target": authProfile("sk-target-plaintext"),
        }),
      ),
    );
    noteCommittedSharedAuthStoreOwnership({ location: "state-db" }, fixture.env);

    const report = await audit();
    const sharedFindings = report.findings
      .filter(
        (entry) =>
          entry.code === "PLAINTEXT_FOUND" &&
          entry.file === resolveSharedAuthStorePath(fixture.env),
      )
      .map((entry) => entry.jsonPath);

    expect(sharedFindings).toContain("profiles.openai:target.key");
    expect(sharedFindings).not.toContain("profiles.openai:ambient.key");
    expect(report.filesScanned).not.toContain(resolveAuthProfileDatabasePath(ambientAgentDir));
  });

  it("exempts direct routing headers but audits request headers in openclaw config", async () => {
    await writeConfig(
      modelsConfig(
        modelProvider(ENV_REF, {
          headers: { "X-Proxy-Region": "us-west" },
          request: { headers: { "X-Proxy-Region": "us-west" } },
        }),
      ),
    );

    const report = await audit();
    expectFinding(
      report,
      {
        code: "PLAINTEXT_FOUND",
        file: fixture.configPath,
        jsonPath: "models.providers.openai.headers.X-Proxy-Region",
      },
      false,
    );
    expectFinding(report, {
      code: "PLAINTEXT_FOUND",
      file: fixture.configPath,
      jsonPath: "models.providers.openai.request.headers.X-Proxy-Region",
    });
  });

  it("scans config and state .env files when the config path is external", async () => {
    await seedAuditFixture(fixture);
    const configDir = path.join(fixture.rootDir, "config");
    const configPath = path.join(configDir, "openclaw.json");
    const configEnvPath = path.join(configDir, ".env");
    await fs.mkdir(configDir, { recursive: true });
    await fs.copyFile(fixture.configPath, configPath);
    await fs.copyFile(fixture.envPath, configEnvPath);
    fixture.env.OPENCLAW_CONFIG_PATH = configPath;

    const report = await audit();
    expectFinding(report, { file: configEnvPath });
    expectFinding(report, { file: fixture.envPath });
  });
});
