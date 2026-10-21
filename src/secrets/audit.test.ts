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
import { runSecretsAudit } from "./audit.js";
import { writeSecretStoreEntry } from "./store/secret-store.js";

type AuditFixture = Awaited<ReturnType<typeof createAuditFixture>>;

const OPENAI_API_KEY_MARKER = "OPENAI_API_KEY"; // pragma: allowlist secret
const ENV_REF = { source: "env", provider: "default", id: OPENAI_API_KEY_MARKER };

function modelProvider(apiKey: unknown = ENV_REF, extra: Record<string, unknown> = {}) {
  return {
    baseUrl: "https://api.openai.com/v1",
    api: "openai-completions",
    apiKey,
    models: [{ id: "gpt-5", name: "gpt-5" }],
    ...extra,
  };
}

function countNonEmptyLines(value: string): number {
  return value.split("\n").filter((line) => line.trim().length > 0).length;
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeAuthStore(fixture: AuditFixture, value: unknown): void {
  writePersistedAuthProfileStoreRaw(value, fixture.agentDir);
}

async function writeExecResolverShellScript(params: {
  scriptPath: string;
  logPath: string;
  values: Record<string, string>;
}) {
  await fs.writeFile(
    params.scriptPath,
    [
      "#!/bin/sh",
      `printf 'x\\n' >> ${JSON.stringify(params.logPath)}`,
      "cat >/dev/null",
      `printf '${JSON.stringify({ protocolVersion: 1, values: params.values }).replaceAll("'", "'\\''")}'`, // pragma: allowlist secret
    ].join("\n"),
    { encoding: "utf8", mode: 0o700 },
  );
}

async function writeExecSecretsAuditConfig(
  fixture: AuditFixture,
  execScriptPath: string,
  headerRefId?: string,
  executionOptions: { timeoutMs?: number; noOutputTimeoutMs?: number; passEnv?: string[] } = {
    timeoutMs: 20_000,
    noOutputTimeoutMs: 10_000,
  },
) {
  await writeJsonFile(fixture.configPath, {
    secrets: {
      providers: {
        execmain: {
          source: "exec",
          command: execScriptPath,
          jsonOnly: true,
          ...executionOptions,
        },
      },
    },
    models: {
      providers: {
        openai: modelProvider(
          execRef("providers/openai/apiKey"),
          headerRefId ? { headers: { Authorization: execRef(headerRefId) } } : {},
        ),
      },
    },
  });
}

const execRef = (id: string) => ({ source: "exec", provider: "execmain", id });
const authProfile = (key: string, keyRef?: unknown) => ({
  type: "api_key",
  provider: "openai",
  key,
  ...(keyRef ? { keyRef } : {}),
});

function resolveRuntimePathEnv(): string {
  const value = process.env.PATH;
  return value?.trim() ? value : "/usr/bin:/bin";
}

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
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-audit-"));
  const stateDir = path.join(rootDir, ".openclaw");
  const configPath = path.join(stateDir, "openclaw.json");
  const agentDir = path.join(stateDir, "agents", "main", "agent");

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.mkdir(agentDir, { recursive: true });

  return {
    rootDir,
    stateDir,
    configPath,
    agentDir,
    authStorePath: resolveAuthProfileDatabasePath(agentDir),
    authJsonPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
    envPath: path.join(stateDir, ".env"),
    env: {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENAI_API_KEY: "env-openai-key", // pragma: allowlist secret
      PATH: resolveRuntimePathEnv(),
    },
  };
}

async function seedAuditFixture(fixture: AuditFixture): Promise<void> {
  await writeJsonFile(fixture.configPath, {
    models: { providers: { openai: modelProvider() } },
  });
  writeAuthStore(fixture, {
    version: 1,
    profiles: {
      "openai:default": { type: "api_key", provider: "openai", key: "sk-openai-plaintext" },
    },
  });
  await writeJsonFile(fixture.modelsPath, {
    providers: {
      openai: modelProvider(OPENAI_API_KEY_MARKER),
    },
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

  async function writeModelsProvider(
    overrides: { apiKey?: unknown; headers?: Record<string, unknown> } = {},
  ) {
    await writeJsonFile(fixture.modelsPath, {
      providers: {
        openai: modelProvider(OPENAI_API_KEY_MARKER, overrides),
      },
    });
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
    await writeSecretStoreEntry({
      scope: { kind: "team" },
      name: "STORED_API_KEY",
      value: "shared-store-value",
      kind: "secret",
      updatedBy: "test",
      database: { env: fixture.env },
    });
    await writeConfig({
      models: {
        providers: {
          plaintext: modelProvider("shared-store-value", {
            baseUrl: "https://plaintext.example.test/v1",
            models: [{ id: "fixture", name: "fixture" }],
          }),
          referenced: modelProvider(
            { source: "store", provider: "default", id: "STORED_API_KEY" },
            {
              baseUrl: "https://referenced.example.test/v1",
              models: [{ id: "fixture", name: "fixture" }],
            },
          ),
          envReferenced: modelProvider("${AUDIT_STORE_VALUE}", {
            baseUrl: "https://env-referenced.example.test/v1",
            models: [{ id: "fixture", name: "fixture" }],
          }),
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

  it("does not inspect or mutate legacy auth.json during audit", async () => {
    await fs.writeFile(fixture.authJsonPath, "{invalid-json", "utf8");

    const report = await audit();
    expectFinding(report, { code: "LEGACY_RESIDUE" });
    expectFinding(report, { file: fixture.authJsonPath });
    expect(report.filesScanned).not.toContain(fixture.authJsonPath);
    await expect(fs.readFile(fixture.authJsonPath, "utf8")).resolves.toBe("{invalid-json");
    await expectPathMissing(fixture.authStorePath);
  });

  it("reports Doctor-created auth archives without reading their contents", async () => {
    const archivePaths = [
      `${fixture.authJsonPath}.migrated-2026-07-25T12-00-00.000Z-fake`,
      `${fixture.authJsonPath}.sqlite-import.1753430400000.bak`,
    ];
    for (const archivePath of archivePaths) {
      await fs.writeFile(archivePath, "opaque fake credential bytes", "utf8");
    }

    const report = await audit();
    expectFinding(report, { code: "LEGACY_RESIDUE" });
    for (const archivePath of archivePaths) {
      expectFinding(report, { file: archivePath });
      expect(report.filesScanned).not.toContain(archivePath);
    }
  });

  it("skips exec ref resolution during audit unless explicitly allowed", async () => {
    if (process.platform === "win32") {
      return;
    }
    const execLogPath = path.join(fixture.rootDir, "exec-calls-skipped.log");
    const execScriptPath = path.join(fixture.rootDir, "resolver-skipped.sh");
    await writeExecResolverShellScript({
      scriptPath: execScriptPath,
      logPath: execLogPath,
      values: {
        "providers/openai/apiKey": "value:providers/openai/apiKey",
      },
    });
    await writeExecSecretsAuditConfig(fixture, execScriptPath);

    const report = await audit();
    expect(report.resolution.resolvabilityComplete).toBe(false);
    expect(report.resolution.skippedExecRefs).toBe(1);
    expect(report.summary.unresolvedRefCount).toBe(0);
    await expectPathMissing(execLogPath);
  });

  it("batches ref resolution per provider during audit when --allow-exec is enabled", async () => {
    if (process.platform === "win32") {
      return;
    }
    const execLogPath = path.join(fixture.rootDir, "exec-calls.log");
    const execScriptPath = path.join(fixture.rootDir, "resolver.sh");
    await writeExecResolverShellScript({
      scriptPath: execScriptPath,
      logPath: execLogPath,
      values: {
        "providers/openai/apiKey": "value:providers/openai/apiKey",
        "providers/openai/headers/Authorization": "value:providers/openai/headers/Authorization",
      },
    });
    await writeExecSecretsAuditConfig(
      fixture,
      execScriptPath,
      "providers/openai/headers/Authorization",
    );

    const report = await audit(true);
    expect(report.summary.unresolvedRefCount).toBe(0);
    expect(report.resolution.refsChecked).toBe(2);

    expect(countNonEmptyLines(await fs.readFile(execLogPath, "utf8"))).toBe(1);
  });

  it("short-circuits per-ref fallback for provider-wide batch failures when --allow-exec is enabled", async () => {
    if (process.platform === "win32") {
      return;
    }
    const execLogPath = path.join(fixture.rootDir, "exec-fail-calls.log");
    const execScriptPath = path.join(fixture.rootDir, "resolver-fail.mjs");
    await fs.writeFile(
      execScriptPath,
      [
        "#!/usr/bin/env node",
        "import fs from 'node:fs';",
        `fs.appendFileSync(${JSON.stringify(execLogPath)}, 'x\\n');`,
        "process.exit(1);",
      ].join("\n"),
      { encoding: "utf8", mode: 0o700 },
    );

    await writeExecSecretsAuditConfig(
      fixture,
      execScriptPath,
      "providers/openai/headers/Authorization",
      { passEnv: ["PATH"] },
    );

    const report = await audit(true);
    expect(report.summary.unresolvedRefCount).toBeGreaterThanOrEqual(2);

    expect(countNonEmptyLines(await fs.readFile(execLogPath, "utf8"))).toBe(1);
  });

  it("scans hardlinked agent models.json files for plaintext provider apiKey values", async () => {
    await writeModelsProvider({ apiKey: "sk-models-plaintext" }); // pragma: allowlist secret
    await fs.link(fixture.modelsPath, path.join(fixture.rootDir, "models-alias.json"));

    const report = await audit();
    expectModelsFinding(report, "PLAINTEXT_FOUND", "providers.openai.apiKey");
    expectModelsFinding(report, "REF_UNRESOLVED", undefined, false);
    expect(report.filesScanned).toContain(fixture.modelsPath);
  });

  it("scans agent models.json files for plaintext provider header values", async () => {
    await writeModelsProvider({
      headers: {
        Authorization: "Bearer sk-header-plaintext", // pragma: allowlist secret
      },
    });

    const report = await audit();
    expectModelsFinding(report, "PLAINTEXT_FOUND", "providers.openai.headers.Authorization");
  });

  it("reports unresolved models.json SecretRef objects in provider headers", async () => {
    await writeModelsProvider({
      headers: {
        Authorization: { ...ENV_REF, id: "OPENAI_HEADER_TOKEN" }, // pragma: allowlist secret
      },
    });

    const report = await audit();
    expectModelsFinding(report, "REF_UNRESOLVED", "providers.openai.headers.Authorization");
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
      providers: {
        openai: modelProvider("sk-external-plaintext"), // pragma: allowlist secret
      },
    });

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
    const stateDatabase = openOpenClawStateDatabase({ env: fixture.env }).db;
    stateDatabase
      .prepare(
        `INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
         VALUES ('auth.sharedStore', ?, 1)`,
      )
      .run(JSON.stringify({ location: "state-db" }));
    stateDatabase
      .prepare(
        "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, 1)",
      )
      .run(
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
    await writeConfig({
      models: {
        providers: {
          openai: modelProvider(ENV_REF, {
            headers: { "X-Proxy-Region": "us-west" },
            request: { headers: { "X-Proxy-Region": "us-west" } },
          }),
        },
      },
    });

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
