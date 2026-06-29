import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAuthProfileDatabasePath } from "../agents/auth-profiles/sqlite.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import type { SecretsApplyPlan } from "./plan.js";

const { clearSecretsRuntimeSnapshotMock, prepareSecretsRuntimeSnapshotMock } = vi.hoisted(() => ({
  clearSecretsRuntimeSnapshotMock: vi.fn(),
  prepareSecretsRuntimeSnapshotMock: vi.fn(async () => undefined),
}));

vi.mock("./runtime.js", () => ({
  clearSecretsRuntimeSnapshot: clearSecretsRuntimeSnapshotMock,
  prepareSecretsRuntimeSnapshot: prepareSecretsRuntimeSnapshotMock,
}));

let runSecretsApply: typeof import("./apply.js").runSecretsApply;

const SHARED_KEY = "sk-shared-proxy-key"; // pragma: allowlist secret
const PROVIDER_AUTH_KEY = "sk-provider-auth-key"; // pragma: allowlist secret

describe("secrets apply env scrub value collision", () => {
  let rootDir: string;
  let stateDir: string;
  let configPath: string;
  let envPath: string;
  let agentDir: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    ({ runSecretsApply } = await import("./apply.js"));
  });

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-envscrub-"));
    stateDir = path.join(rootDir, "state");
    configPath = path.join(stateDir, "openclaw.json");
    envPath = path.join(stateDir, ".env");
    agentDir = path.join(stateDir, "agents", "main", "agent");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(agentDir, { recursive: true });

    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          models: {
            providers: {
              openai: { apiKey: SHARED_KEY },
              anthropic: {
                apiKey: { source: "env", provider: "default", id: "ANTHROPIC_API_KEY" },
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await fs.writeFile(
      envPath,
      `OPENAI_API_KEY=${SHARED_KEY}\nANTHROPIC_API_KEY=${SHARED_KEY}\nUNRELATED=value\n`,
      "utf8",
    );

    env = {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENAI_API_KEY: SHARED_KEY,
      ANTHROPIC_API_KEY: SHARED_KEY,
    };
  });

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("does NOT delete ANTHROPIC_API_KEY when only the openai apiKey is migrated", async () => {
    const plan: SecretsApplyPlan = {
      version: 1,
      protocolVersion: 1,
      generatedAt: new Date().toISOString(),
      generatedBy: "manual",
      targets: [
        {
          type: "models.providers.apiKey",
          path: "models.providers.openai.apiKey",
          providerId: "openai",
          ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
      ],
      options: {
        scrubEnv: true,
        scrubAuthProfilesForProviderTargets: true,
        scrubLegacyAuthJson: true,
      },
    };

    await runSecretsApply({ plan, env, write: true });

    const nextEnv = await fs.readFile(envPath, "utf8");

    expect(nextEnv).toContain("ANTHROPIC_API_KEY");
    expect(nextEnv).toContain("UNRELATED=value");
    expect(nextEnv).not.toContain(`OPENAI_API_KEY=${SHARED_KEY}`);
  });

  it("still scrubs the .env line when only an auth-profile credential is migrated", async () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: SHARED_KEY,
        },
      },
    } as unknown as AuthProfileStore;
    saveAuthProfileStore(store, agentDir, {
      filterExternalAuthProfiles: false,
      syncExternalCli: false,
    });
    expect(resolveAuthProfileDatabasePath(agentDir)).toContain(agentDir);

    await fs.writeFile(envPath, `OPENAI_API_KEY=${SHARED_KEY}\nUNRELATED=value\n`, "utf8");

    const plan: SecretsApplyPlan = {
      version: 1,
      protocolVersion: 1,
      generatedAt: new Date().toISOString(),
      generatedBy: "manual",
      targets: [
        {
          type: "auth-profiles.api_key.key",
          path: "profiles.openai:default.key",
          pathSegments: ["profiles", "openai:default", "key"],
          agentId: "main",
          authProfileProvider: "openai",
          ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
      ],
      options: {
        scrubEnv: true,
        scrubAuthProfilesForProviderTargets: true,
        scrubLegacyAuthJson: true,
      },
    };

    await runSecretsApply({ plan, env, write: true });

    const nextEnv = await fs.readFile(envPath, "utf8");

    expect(nextEnv).toContain("UNRELATED=value");
    expect(nextEnv).not.toContain(`OPENAI_API_KEY=${SHARED_KEY}`);
  });

  it("does NOT delete OPENAI_API_KEY when only a same-value provider header is migrated", async () => {
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          models: {
            providers: {
              openai: {
                apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
                headers: { "x-shared-header": SHARED_KEY },
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.writeFile(
      envPath,
      `OPENAI_API_KEY=${SHARED_KEY}\nOPENAI_PROXY_HEADER=${SHARED_KEY}\nUNRELATED=value\n`,
      "utf8",
    );
    env.OPENAI_PROXY_HEADER = SHARED_KEY;

    const plan: SecretsApplyPlan = {
      version: 1,
      protocolVersion: 1,
      generatedAt: new Date().toISOString(),
      generatedBy: "manual",
      targets: [
        {
          type: "models.providers.headers",
          path: "models.providers.openai.headers.x-shared-header",
          pathSegments: ["models", "providers", "openai", "headers", "x-shared-header"],
          providerId: "openai",
          ref: { source: "env", provider: "default", id: "OPENAI_PROXY_HEADER" },
        },
      ],
      options: {
        scrubEnv: true,
        scrubAuthProfilesForProviderTargets: true,
        scrubLegacyAuthJson: true,
      },
    };

    await runSecretsApply({ plan, env, write: true });

    const nextEnv = await fs.readFile(envPath, "utf8");

    expect(nextEnv).toContain(`OPENAI_API_KEY=${SHARED_KEY}`);
    expect(nextEnv).toContain("UNRELATED=value");
  });

  it("does NOT delete OPENAI_API_KEY when a same-value provider header is migrated to that auth env ref", async () => {
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          models: {
            providers: {
              openai: {
                apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
                headers: { "x-shared-header": SHARED_KEY },
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.writeFile(envPath, `OPENAI_API_KEY=${SHARED_KEY}\nUNRELATED=value\n`, "utf8");

    const plan: SecretsApplyPlan = {
      version: 1,
      protocolVersion: 1,
      generatedAt: new Date().toISOString(),
      generatedBy: "manual",
      targets: [
        {
          type: "models.providers.headers",
          path: "models.providers.openai.headers.x-shared-header",
          pathSegments: ["models", "providers", "openai", "headers", "x-shared-header"],
          providerId: "openai",
          ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
      ],
      options: {
        scrubEnv: true,
        scrubAuthProfilesForProviderTargets: true,
        scrubLegacyAuthJson: true,
      },
    };

    await runSecretsApply({ plan, env, write: true });

    const nextEnv = await fs.readFile(envPath, "utf8");

    expect(nextEnv).toContain(`OPENAI_API_KEY=${SHARED_KEY}`);
    expect(nextEnv).toContain("UNRELATED=value");
  });

  it("scrubs a plugin/config target env line while preserving an unrelated same-value provider", async () => {
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          tools: { web: { fetch: { firecrawl: { apiKey: SHARED_KEY } } } },
          models: { providers: { openai: { apiKey: SHARED_KEY } } },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.writeFile(
      envPath,
      `FIRECRAWL_API_KEY=${SHARED_KEY}\nOPENAI_API_KEY=${SHARED_KEY}\nUNRELATED=value\n`,
      "utf8",
    );
    env.FIRECRAWL_API_KEY = SHARED_KEY;

    const plan: SecretsApplyPlan = {
      version: 1,
      protocolVersion: 1,
      generatedAt: new Date().toISOString(),
      generatedBy: "manual",
      targets: [
        {
          type: "tools.web.fetch.firecrawl.apiKey",
          path: "tools.web.fetch.firecrawl.apiKey",
          ref: { source: "env", provider: "default", id: "FIRECRAWL_API_KEY" },
        },
      ],
      options: {
        scrubEnv: true,
        scrubAuthProfilesForProviderTargets: true,
        scrubLegacyAuthJson: true,
      },
    };

    await runSecretsApply({ plan, env, write: true });

    const nextEnv = await fs.readFile(envPath, "utf8");

    expect(nextEnv).toContain(`OPENAI_API_KEY=${SHARED_KEY}`);
    expect(nextEnv).toContain("UNRELATED=value");
    expect(nextEnv).not.toContain(`FIRECRAWL_API_KEY=${SHARED_KEY}`);
  });

  it("keeps a non-provider env-ref source line when its key is not a known secret env var", async () => {
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ gateway: { auth: { token: SHARED_KEY } } }, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(envPath, `OPENCLAW_GATEWAY_TOKEN=${SHARED_KEY}\nUNRELATED=value\n`, "utf8");
    env.OPENCLAW_GATEWAY_TOKEN = SHARED_KEY;

    const plan: SecretsApplyPlan = {
      version: 1,
      protocolVersion: 1,
      generatedAt: new Date().toISOString(),
      generatedBy: "manual",
      targets: [
        {
          type: "gateway.auth.token",
          path: "gateway.auth.token",
          ref: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" },
        },
      ],
      options: {
        scrubEnv: true,
        scrubAuthProfilesForProviderTargets: true,
        scrubLegacyAuthJson: true,
      },
    };

    await runSecretsApply({ plan, env, write: true });

    const nextEnv = await fs.readFile(envPath, "utf8");

    expect(nextEnv).toContain(`OPENCLAW_GATEWAY_TOKEN=${SHARED_KEY}`);
    expect(nextEnv).toContain("UNRELATED=value");
  });

  it("scrubs the provider .env line for an existing auth-profile migrating to a file ref without authProfileProvider", async () => {
    const secretFilePath = path.join(rootDir, "openai.key");
    await fs.writeFile(secretFilePath, SHARED_KEY, "utf8");

    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          secrets: {
            providers: {
              mounted: {
                source: "file",
                path: secretFilePath,
                mode: "singleValue",
                allowInsecurePath: true,
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: SHARED_KEY,
        },
      },
    } as unknown as AuthProfileStore;
    saveAuthProfileStore(store, agentDir, {
      filterExternalAuthProfiles: false,
      syncExternalCli: false,
    });

    await fs.writeFile(envPath, `OPENAI_API_KEY=${SHARED_KEY}\nUNRELATED=value\n`, "utf8");

    const plan: SecretsApplyPlan = {
      version: 1,
      protocolVersion: 1,
      generatedAt: new Date().toISOString(),
      generatedBy: "manual",
      targets: [
        {
          type: "auth-profiles.api_key.key",
          path: "profiles.openai:default.key",
          pathSegments: ["profiles", "openai:default", "key"],
          agentId: "main",
          ref: { source: "file", provider: "mounted", id: "value" },
        },
      ],
      options: {
        scrubEnv: true,
        scrubAuthProfilesForProviderTargets: true,
        scrubLegacyAuthJson: true,
      },
    };

    await runSecretsApply({ plan, env, write: true });

    const nextEnv = await fs.readFile(envPath, "utf8");

    expect(nextEnv).toContain("UNRELATED=value");
    expect(nextEnv).not.toContain(`OPENAI_API_KEY=${SHARED_KEY}`);
  });

  it("scrubs the provider .env line when a talk provider apiKey is migrated to a non-env ref", async () => {
    const secretFilePath = path.join(rootDir, "talk-openai.key");
    await fs.writeFile(secretFilePath, SHARED_KEY, "utf8");

    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          secrets: {
            providers: {
              mounted: {
                source: "file",
                path: secretFilePath,
                mode: "singleValue",
                allowInsecurePath: true,
              },
            },
          },
          talk: { providers: { openai: { apiKey: SHARED_KEY } } },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await fs.writeFile(envPath, `OPENAI_API_KEY=${SHARED_KEY}\nUNRELATED=value\n`, "utf8");

    const plan: SecretsApplyPlan = {
      version: 1,
      protocolVersion: 1,
      generatedAt: new Date().toISOString(),
      generatedBy: "manual",
      targets: [
        {
          type: "talk.providers.*.apiKey",
          path: "talk.providers.openai.apiKey",
          providerId: "openai",
          ref: { source: "file", provider: "mounted", id: "value" },
        },
      ],
      options: {
        scrubEnv: true,
        scrubAuthProfilesForProviderTargets: true,
        scrubLegacyAuthJson: true,
      },
    };

    await runSecretsApply({ plan, env, write: true });

    const nextEnv = await fs.readFile(envPath, "utf8");

    expect(nextEnv).toContain("UNRELATED=value");
    expect(nextEnv).not.toContain(`OPENAI_API_KEY=${SHARED_KEY}`);
  });

  it("scrubs a non-provider plugin apiKey env line when it is migrated to a non-env (file) ref", async () => {
    const secretFilePath = path.join(rootDir, "firecrawl.key");
    await fs.writeFile(secretFilePath, SHARED_KEY, "utf8");

    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          secrets: {
            providers: {
              mounted: {
                source: "file",
                path: secretFilePath,
                mode: "singleValue",
                allowInsecurePath: true,
              },
            },
          },
          tools: { web: { fetch: { firecrawl: { apiKey: SHARED_KEY } } } },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await fs.writeFile(
      envPath,
      `FIRECRAWL_API_KEY=${SHARED_KEY}\nOPENAI_API_KEY=${SHARED_KEY}\nUNRELATED=value\n`,
      "utf8",
    );
    env.FIRECRAWL_API_KEY = SHARED_KEY;

    const plan: SecretsApplyPlan = {
      version: 1,
      protocolVersion: 1,
      generatedAt: new Date().toISOString(),
      generatedBy: "manual",
      targets: [
        {
          type: "tools.web.fetch.firecrawl.apiKey",
          path: "tools.web.fetch.firecrawl.apiKey",
          ref: { source: "file", provider: "mounted", id: "value" },
        },
      ],
      options: {
        scrubEnv: true,
        scrubAuthProfilesForProviderTargets: true,
        scrubLegacyAuthJson: true,
      },
    };

    await runSecretsApply({ plan, env, write: true });

    const nextEnv = await fs.readFile(envPath, "utf8");

    expect(nextEnv).toContain(`OPENAI_API_KEY=${SHARED_KEY}`);
    expect(nextEnv).toContain("UNRELATED=value");
    expect(nextEnv).not.toContain(`FIRECRAWL_API_KEY=${SHARED_KEY}`);
  });

  it("does NOT delete OPENAI_API_KEY when a no-op already-ref openai target shares a value with a migrated plugin target", async () => {
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          tools: { web: { fetch: { firecrawl: { apiKey: SHARED_KEY } } } },
          models: {
            providers: {
              openai: {
                apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.writeFile(
      envPath,
      `OPENAI_API_KEY=${SHARED_KEY}\nFIRECRAWL_API_KEY=${SHARED_KEY}\nUNRELATED=value\n`,
      "utf8",
    );
    env.FIRECRAWL_API_KEY = SHARED_KEY;

    const plan: SecretsApplyPlan = {
      version: 1,
      protocolVersion: 1,
      generatedAt: new Date().toISOString(),
      generatedBy: "manual",
      targets: [
        {
          type: "models.providers.apiKey",
          path: "models.providers.openai.apiKey",
          providerId: "openai",
          ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
        {
          type: "tools.web.fetch.firecrawl.apiKey",
          path: "tools.web.fetch.firecrawl.apiKey",
          ref: { source: "env", provider: "default", id: "FIRECRAWL_API_KEY" },
        },
      ],
      options: {
        scrubEnv: true,
        scrubAuthProfilesForProviderTargets: true,
        scrubLegacyAuthJson: true,
      },
    };

    await runSecretsApply({ plan, env, write: true });

    const nextEnv = await fs.readFile(envPath, "utf8");

    expect(nextEnv).toContain(`OPENAI_API_KEY=${SHARED_KEY}`);
    expect(nextEnv).toContain("UNRELATED=value");
    expect(nextEnv).not.toContain(`FIRECRAWL_API_KEY=${SHARED_KEY}`);
  });

  it("does NOT delete OPENAI_API_KEY when provider auth and a same-provider header are migrated together", async () => {
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          models: {
            providers: {
              openai: {
                apiKey: PROVIDER_AUTH_KEY,
                headers: { "x-shared-header": SHARED_KEY },
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.writeFile(
      envPath,
      `OPENAI_API_KEY=${SHARED_KEY}\nOPENAI_AUTH_KEY=${PROVIDER_AUTH_KEY}\nUNRELATED=value\n`,
      "utf8",
    );
    env.OPENAI_AUTH_KEY = PROVIDER_AUTH_KEY;

    const plan: SecretsApplyPlan = {
      version: 1,
      protocolVersion: 1,
      generatedAt: new Date().toISOString(),
      generatedBy: "manual",
      targets: [
        {
          type: "models.providers.apiKey",
          path: "models.providers.openai.apiKey",
          providerId: "openai",
          ref: { source: "env", provider: "default", id: "OPENAI_AUTH_KEY" },
        },
        {
          type: "models.providers.headers",
          path: "models.providers.openai.headers.x-shared-header",
          pathSegments: ["models", "providers", "openai", "headers", "x-shared-header"],
          providerId: "openai",
          ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
      ],
      options: {
        scrubEnv: true,
        scrubAuthProfilesForProviderTargets: true,
        scrubLegacyAuthJson: true,
      },
    };

    await runSecretsApply({ plan, env, write: true });

    const nextEnv = await fs.readFile(envPath, "utf8");

    expect(nextEnv).toContain(`OPENAI_API_KEY=${SHARED_KEY}`);
    expect(nextEnv).toContain(`OPENAI_AUTH_KEY=${PROVIDER_AUTH_KEY}`);
    expect(nextEnv).toContain("UNRELATED=value");
  });
});
