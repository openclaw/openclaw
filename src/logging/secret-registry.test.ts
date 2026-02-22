import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  resetRuntimeRedactionSecretsCacheForTest,
  resolveRuntimeRedactionSecrets,
} from "./secret-registry.js";

describe("resolveRuntimeRedactionSecrets", () => {
  let tmpDir = "";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secret-registry-"));
    resetRuntimeRedactionSecretsCacheForTest();
  });

  afterEach(async () => {
    resetRuntimeRedactionSecretsCacheForTest();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("collects secrets from config, env, and credential files", async () => {
    const credentialsDir = path.join(tmpDir, "credentials");
    await fs.mkdir(credentialsDir, { recursive: true });
    await fs.writeFile(
      path.join(credentialsDir, "oauth.json"),
      JSON.stringify({
        accessToken: "cred-access-token-1234567890",
        nested: { apiKey: "cred-nested-api-key-1234567890" },
      }),
      "utf-8",
    );
    await fs.writeFile(path.join(credentialsDir, "legacy.txt"), "token=cred-line-token-1234567890");

    const config: OpenClawConfig = {
      gateway: {
        auth: {
          token: "gateway-token-1234567890",
          password: "gateway-password-1234567890",
        },
      },
      skills: {
        entries: {
          demo: {
            apiKey: "skill-api-key-1234567890",
            env: {
              CUSTOM_SECRET_TOKEN: "skill-env-secret-1234567890",
              NON_SECRET_NAME: "not-collected",
            },
          },
        },
      },
    };

    const secrets = resolveRuntimeRedactionSecrets({
      config,
      env: {
        OPENCLAW_GATEWAY_TOKEN: "env-gateway-token-1234567890",
        OPENCLAW_GATEWAY_PASSWORD: "env-gateway-password-1234567890",
        OPENCLAW_OAUTH_DIR: credentialsDir,
      } as NodeJS.ProcessEnv,
      nowMs: 1,
    });

    expect(secrets).toContain("gateway-token-1234567890");
    expect(secrets).toContain("gateway-password-1234567890");
    expect(secrets).toContain("skill-api-key-1234567890");
    expect(secrets).toContain("skill-env-secret-1234567890");
    expect(secrets).toContain("env-gateway-token-1234567890");
    expect(secrets).toContain("env-gateway-password-1234567890");
    expect(secrets).toContain("cred-access-token-1234567890");
    expect(secrets).toContain("cred-nested-api-key-1234567890");
    expect(secrets).toContain("cred-line-token-1234567890");
    expect(secrets[0].length).toBeGreaterThanOrEqual(secrets.at(-1)!.length);
  });

  it("skips placeholders and short values", () => {
    const config: OpenClawConfig = {
      gateway: {
        auth: {
          token: "${OPENCLAW_GATEWAY_TOKEN}",
          password: "abc",
        },
      },
      skills: {
        entries: {
          demo: {
            apiKey: "   ",
            env: {
              API_KEY: "${OPENAI_API_KEY}",
              SECRET: "xyz",
            },
          },
        },
      },
    };

    const secrets = resolveRuntimeRedactionSecrets({
      config,
      env: {
        OPENCLAW_GATEWAY_TOKEN: "123",
        OPENCLAW_GATEWAY_PASSWORD: "env-password-1234567890",
      } as NodeJS.ProcessEnv,
      nowMs: 1,
    });

    expect(secrets).toEqual(["env-password-1234567890"]);
  });
});
