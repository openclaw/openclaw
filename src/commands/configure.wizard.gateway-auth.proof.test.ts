/**
 * Real Gateway auth proof for configure-wizard blank OPENCLAW_GATEWAY_* env.
 * Exercises production probeGatewayReachable / waitForGatewayReachable against
 * a token-auth Gateway — same credential resolution as configure.wizard.ts.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installGatewayTestHooks, startServer, testState } from "../gateway/test-helpers.js";
import { probeGatewayReachable, waitForGatewayReachable } from "./onboard-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const CONFIGURED_TOKEN = "wizard-configured-gateway-token";
const WRONG_ENV_TOKEN = "wizard-wrong-env-token";

/** Same contract as configure.wizard resolveWizardGatewayEnvOverride. */
function resolveWizardGatewayEnvOverride(
  envValue: string | undefined,
  configured: string | undefined,
): string | undefined {
  return normalizeOptionalString(envValue) ?? configured;
}

function resolveLegacyEnvOverride(
  envValue: string | undefined,
  configured: string | undefined,
): string | undefined {
  return envValue ?? configured;
}

function redactEnv(env: string | undefined): string {
  if (env === undefined) {
    return "<unset>";
  }
  if (env.length === 0) {
    return "<empty>";
  }
  if (env.trim().length === 0) {
    return "<whitespace>";
  }
  return env === CONFIGURED_TOKEN
    ? "<configured>"
    : env === WRONG_ENV_TOKEN
      ? "<wrong>"
      : "<other>";
}

function redactToken(token: string | undefined): string {
  if (token === undefined) {
    return "<none>";
  }
  if (token === CONFIGURED_TOKEN) {
    return "<configured>";
  }
  if (token === WRONG_ENV_TOKEN) {
    return "<wrong>";
  }
  if (token.trim().length === 0) {
    return token.length === 0 ? "<empty>" : "<whitespace>";
  }
  return "<other>";
}

function emitProof(row: Record<string, unknown>): void {
  process.stdout.write(`PROOF ${JSON.stringify(row)}\n`);
}

describe("configure wizard blank gateway env — live Gateway proof", () => {
  const originalGatewayAuth = testState.gatewayAuth;
  let port = 0;
  let server: Awaited<ReturnType<typeof startServer>>["server"];
  let envSnapshot: Awaited<ReturnType<typeof startServer>>["envSnapshot"];

  beforeAll(async () => {
    const started = await startServer(CONFIGURED_TOKEN, { controlUiEnabled: false });
    port = started.port;
    server = started.server;
    envSnapshot = started.envSnapshot;
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    envSnapshot?.restore();
    testState.gatewayAuth = originalGatewayAuth;
  });

  it("blank/whitespace env use configured token against a real token-auth Gateway", async () => {
    const url = `ws://127.0.0.1:${port}`;
    const cases: Array<{ name: string; env: string | undefined }> = [
      { name: "empty", env: "" },
      { name: "whitespace", env: "   " },
      { name: "unset", env: undefined },
      { name: "nonblank-wrong", env: WRONG_ENV_TOKEN },
      { name: "nonblank-correct", env: CONFIGURED_TOKEN },
    ];

    for (const { name, env } of cases) {
      const afterToken = resolveWizardGatewayEnvOverride(env, CONFIGURED_TOKEN);
      const beforeToken = resolveLegacyEnvOverride(env, CONFIGURED_TOKEN);

      const afterProbe = await probeGatewayReachable({
        url,
        token: afterToken,
        timeoutMs: 5_000,
      });
      const beforeProbe = await probeGatewayReachable({
        url,
        token: beforeToken,
        timeoutMs: 5_000,
      });

      const expectAfterOk = name !== "nonblank-wrong";
      const expectBeforeOk = name === "unset" || name === "nonblank-correct";

      emitProof({
        case: name,
        env: redactEnv(env),
        afterToken: redactToken(afterToken),
        beforeToken: redactToken(beforeToken),
        afterOk: afterProbe.ok,
        beforeOk: beforeProbe.ok,
        afterDetail: afterProbe.ok ? null : (afterProbe.detail ?? "failed"),
        beforeDetail: beforeProbe.ok ? null : (beforeProbe.detail ?? "failed"),
      });

      expect(afterProbe.ok, `after ${name}`).toBe(expectAfterOk);
      expect(beforeProbe.ok, `before ${name}`).toBe(expectBeforeOk);
    }
  }, 60_000);

  it("health wait with blank env token reaches a real Gateway using configured auth", async () => {
    const url = `ws://127.0.0.1:${port}`;
    const token = resolveWizardGatewayEnvOverride("", CONFIGURED_TOKEN);
    const legacyToken = resolveLegacyEnvOverride("", CONFIGURED_TOKEN);

    const afterWait = await waitForGatewayReachable({
      url,
      token,
      deadlineMs: 8_000,
      probeTimeoutMs: 2_000,
      pollMs: 200,
    });
    const beforeWait = await waitForGatewayReachable({
      url,
      token: legacyToken,
      deadlineMs: 3_000,
      probeTimeoutMs: 1_000,
      pollMs: 200,
    });

    emitProof({
      case: "health-wait-empty-env",
      afterToken: redactToken(token),
      beforeToken: redactToken(legacyToken),
      afterOk: afterWait.ok,
      beforeOk: beforeWait.ok,
      beforeDetail: beforeWait.ok ? null : (beforeWait.detail ?? "failed"),
    });

    expect(afterWait.ok).toBe(true);
    expect(beforeWait.ok).toBe(false);
  }, 60_000);
});
