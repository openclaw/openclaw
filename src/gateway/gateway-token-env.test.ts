import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GATEWAY_TOKEN_ENV_REF,
  isGatewayTokenEnvReference,
  resolveGatewayTokenForStorage,
  upsertGatewayTokenDotEnv,
  withGatewayTokenEnvReference,
} from "./gateway-token-env.js";

const isWindows = process.platform === "win32";

const expectPerms = (actual: number, expected: number) => {
  if (isWindows) {
    expect([expected, 0o666, 0o777]).toContain(actual);
    return;
  }
  expect(actual).toBe(expected);
};

describe("gateway token env helpers", () => {
  let fixtureRoot = "";
  let fixtureCount = 0;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-token-env-"));
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  const createStateDir = async () => {
    const stateDir = path.join(fixtureRoot, `state-${fixtureCount++}`);
    await fs.mkdir(stateDir, { recursive: true });
    return stateDir;
  };

  it("upserts OPENCLAW_GATEWAY_TOKEN into ~/.openclaw/.env with private perms", async () => {
    const stateDir = await createStateDir();
    const envPath = path.join(stateDir, ".env");
    await fs.writeFile(envPath, "FOO=1\nOPENCLAW_GATEWAY_TOKEN=old\nBAR=2\n", "utf-8");

    const env = { ...process.env } as NodeJS.ProcessEnv;
    const result = await upsertGatewayTokenDotEnv({
      token: "new-token-value",
      env,
      stateDir,
    });

    expect(result.dotenvPath).toBe(envPath);
    expect(result.changed).toBe(true);
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBe("new-token-value");

    const raw = await fs.readFile(envPath, "utf-8");
    expect(raw).toContain("FOO=1\n");
    expect(raw).toContain("BAR=2\n");
    expect(raw).toContain("OPENCLAW_GATEWAY_TOKEN=new-token-value\n");
    expect(raw.match(/OPENCLAW_GATEWAY_TOKEN=/g)?.length ?? 0).toBe(1);

    const mode = (await fs.stat(envPath)).mode & 0o777;
    expectPerms(mode, 0o600);
  });

  it("canonicalizes config token to env reference for token mode", () => {
    const cfg = {
      gateway: {
        auth: {
          mode: "token" as const,
          token: "literal-token",
        },
      },
    };
    const next = withGatewayTokenEnvReference(cfg, "literal-token");
    expect(next.gateway?.auth?.token).toBe(GATEWAY_TOKEN_ENV_REF);
    expect(isGatewayTokenEnvReference(next.gateway?.auth?.token)).toBe(true);
  });

  it("prefers literal config token and falls back to OPENCLAW_GATEWAY_TOKEN env", () => {
    const fromConfig = resolveGatewayTokenForStorage(
      {
        gateway: { auth: { mode: "token", token: "config-token" } },
      },
      { OPENCLAW_GATEWAY_TOKEN: "env-token" } as NodeJS.ProcessEnv,
    );
    expect(fromConfig).toBe("config-token");

    const fromEnv = resolveGatewayTokenForStorage(
      {
        gateway: { auth: { mode: "token", token: GATEWAY_TOKEN_ENV_REF } },
      },
      { OPENCLAW_GATEWAY_TOKEN: "env-token" } as NodeJS.ProcessEnv,
    );
    expect(fromEnv).toBe("env-token");
  });
});
