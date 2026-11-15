import { randomBytes } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { GatewayConfigSchema } from "../config/zod-schema.gateway.js";
import { captureGatewayAuthPolicy, isGatewayAuthPolicyCurrent } from "./auth-policy.js";
import {
  authorizeHttpGatewayConnect,
  authorizeWsControlUiGatewayConnect,
  resolveGatewayAuth,
} from "./auth.js";
import { disposeGatewayDelegationCredentials } from "./trusted-proxy-delegation.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(disposeGatewayDelegationCredentials);

function fixture() {
  const credentialFile = join(tempDirs.make("gateway-delegation-"), "key");
  const key = randomBytes(32).toString("hex");
  writeFileSync(credentialFile, key, { mode: 0o600 });
  const subject = `oce:v1:${"a".repeat(64)}`;
  const cfg: OpenClawConfig = {
    gateway: {
      auth: {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-occ-identity",
          allowLoopback: true,
          allowUsers: ["static@example.test"],
          delegation: { credentialFile },
        },
      },
      trustedProxies: ["127.0.0.1"],
    },
  };
  const headers = {
    "x-occ-identity": subject,
    "x-occ-browser-key": key,
    "x-openclaw-scopes": "operator.sessions.write",
    "x-forwarded-for": "203.0.113.10",
    "x-forwarded-proto": "https",
  };
  const request = (changes: Record<string, string | undefined> = {}, remoteAddress = "127.0.0.1") =>
    ({
      headers: { ...headers, ...changes },
      socket: { remoteAddress },
    }) as unknown as IncomingMessage;
  return { cfg, subject, key, credentialFile, request };
}

it("admits the delegated person on HTTP and WS independently of the static roster", async () => {
  const { cfg, subject, request } = fixture();
  expect(GatewayConfigSchema.safeParse(cfg.gateway).success).toBe(true);
  for (const authorize of [authorizeHttpGatewayConnect, authorizeWsControlUiGatewayConnect]) {
    const result = await authorize({
      auth: resolveGatewayAuth({ authConfig: cfg.gateway?.auth }),
      req: request(),
      trustedProxies: cfg.gateway?.trustedProxies,
    });
    expect(result).toMatchObject({
      ok: true,
      method: "trusted-proxy",
      user: subject,
      delegation: {
        identity: { authority: "oce", subject },
        scopes: ["operator.sessions.write"],
      },
    });
  }
});

it("refuses invalid delegation and alternate credentials", async () => {
  const { cfg, request, key, subject, credentialFile } = fixture();
  for (const delegation of [
    {},
    { credentialFile: "relative/key" },
    { credentialFile, authority: "oce" },
    { credentialFile, subjectPrefix: "oce:v1:" },
  ]) {
    expect(
      GatewayConfigSchema.safeParse({
        auth: { mode: "trusted-proxy", trustedProxy: { userHeader: "x-occ-identity", delegation } },
      }).success,
    ).toBe(false);
  }
  const auth = resolveGatewayAuth({ authConfig: cfg.gateway?.auth });
  const cases = [
    request({ "x-occ-browser-key": undefined }),
    request({ "x-occ-browser-key": randomBytes(32).toString("hex") }),
    request({ "x-occ-identity": "oce:v1:malformed" }),
    // Node joins repeated custom HTTP headers; neither identity nor credential may be ambiguous.
    request({ "x-occ-identity": `${subject}, ${subject}` }),
    request({ "x-occ-browser-key": `${key}, ${key}` }),
    request({ "x-openclaw-scopes": "operator.admin,operator.sessions.write" }),
    request({ "x-openclaw-scopes": undefined }),
    request({}, "203.0.113.20"),
  ];
  for (const req of cases) {
    expect(
      (
        await authorizeHttpGatewayConnect({
          auth,
          req,
          trustedProxies: cfg.gateway?.trustedProxies,
        })
      ).ok,
    ).toBe(false);
  }
  for (const mode of ["token", "password", "none"] as const) {
    const credential = randomBytes(32).toString("hex");
    const options = {
      auth: { mode, token: credential, password: credential, allowTailscale: false },
      connectAuth: { token: credential, password: credential },
      trustedProxies: cfg.gateway?.trustedProxies,
    };
    expect((await authorizeHttpGatewayConnect({ ...options, req: request() })).ok).toBe(false);
    expect(
      (
        await authorizeHttpGatewayConnect({
          ...options,
          req: request({ "x-occ-identity": undefined, "x-occ-browser-key": undefined }),
        })
      ).ok,
    ).toBe(true);
  }
  expect(
    await authorizeHttpGatewayConnect({
      auth,
      req: request({
        "x-occ-identity": "static@example.test",
        "x-occ-browser-key": undefined,
        "x-openclaw-scopes": undefined,
      }),
      trustedProxies: cfg.gateway?.trustedProxies,
    }),
  ).toMatchObject({ ok: true, user: "static@example.test" });
});

it("invalidates old grants through credential replacement and restoration", async () => {
  const { cfg, request, credentialFile, key } = fixture();
  const result = await authorizeHttpGatewayConnect({
    auth: resolveGatewayAuth({ authConfig: cfg.gateway?.auth }),
    req: request(),
    trustedProxies: cfg.gateway?.trustedProxies,
  });
  expect(result.ok).toBe(true);
  const policy = captureGatewayAuthPolicy(cfg, {
    role: "operator",
    authMethod: result.method,
    verifiedIdentity: result.user,
    delegation: result.delegation,
  });
  expect(isGatewayAuthPolicyCurrent(policy, cfg)).toBe(true);
  writeFileSync(credentialFile, randomBytes(32).toString("hex"));
  // This waits for the real projected-file watcher, not a mocked authorization decision.
  await vi.waitFor(() => expect(isGatewayAuthPolicyCurrent(policy, cfg)).toBe(false), {
    timeout: 3000,
  });
  writeFileSync(credentialFile, key);
  await vi.waitFor(
    async () => {
      expect(
        (
          await authorizeHttpGatewayConnect({
            auth: resolveGatewayAuth({ authConfig: cfg.gateway?.auth }),
            req: request(),
            trustedProxies: cfg.gateway?.trustedProxies,
          })
        ).ok,
      ).toBe(true);
    },
    { timeout: 3000 },
  );
  expect(isGatewayAuthPolicyCurrent(policy, cfg)).toBe(false);
  const restored = await authorizeHttpGatewayConnect({
    auth: resolveGatewayAuth({ authConfig: cfg.gateway?.auth }),
    req: request(),
    trustedProxies: cfg.gateway?.trustedProxies,
  });
  expect(restored.ok).toBe(true);
  const restoredPolicy = captureGatewayAuthPolicy(cfg, {
    role: "operator",
    authMethod: restored.method,
    verifiedIdentity: restored.user,
    delegation: restored.delegation,
  });
  // An unchanged polling cycle must retain current grants, not revoke on every tick.
  await delay(1100);
  expect(isGatewayAuthPolicyCurrent(restoredPolicy, cfg)).toBe(true);
  // Replacing the file is a new credential revision even when its bytes are unchanged.
  const replacement = `${credentialFile}.next`;
  writeFileSync(replacement, key, { mode: 0o600 });
  renameSync(replacement, credentialFile);
  await vi.waitFor(() => expect(isGatewayAuthPolicyCurrent(restoredPolicy, cfg)).toBe(false), {
    timeout: 3000,
  });
});
