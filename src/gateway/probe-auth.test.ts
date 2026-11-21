import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { REDACTED_SENTINEL } from "../config/redact-sentinel.js";
import {
  resolveGatewayProbeAuthSafe,
  resolveGatewayProbeAuthSafeWithSecretInputs,
  resolveGatewayProbeTarget,
} from "./probe-auth.js";

type Gateway = NonNullable<OpenClawConfig["gateway"]>;
type Input = Parameters<typeof resolveGatewayProbeAuthSafeWithSecretInputs>[0];
type Auth = Awaited<ReturnType<typeof resolveGatewayProbeAuthSafeWithSecretInputs>>["auth"];
type ProbeCase = [string, Input, Auth, string[]?];
const EMPTY_AUTH = { token: undefined, password: undefined };
const REMOTE_URL = "wss://gateway.example";
const AMBIENT_AUTH = {
  OPENCLAW_GATEWAY_TOKEN: "ambient-token",
  OPENCLAW_GATEWAY_PASSWORD: "ambient-password",
};
const ref = (id: string) => ({ source: "env" as const, provider: "default", id });
const config = (gateway: Gateway): OpenClawConfig => ({
  gateway,
  secrets: { providers: { default: { source: "env" } } },
});
const local = (auth: Gateway["auth"], options: Partial<Omit<Input, "cfg">> = {}): Input => ({
  cfg: config({ auth }),
  mode: "local",
  env: {},
  ...options,
});
const envFirst = (auth: Gateway["auth"]) =>
  local(auth, {
    localPrecedence: "env-first",
    env: { ...AMBIENT_AUTH, PROBE_SECRET: "resolved-secret" },
  });
const remote = (credentials: Gateway["remote"]): Input => ({
  cfg: config({ mode: "remote", remote: { url: REMOTE_URL, ...credentials } }),
  mode: "remote",
  env: { ...AMBIENT_AUTH, REMOTE: "remote" },
});

it.each([
  ["local", { auth: { token: "token-value" } }, { token: "token-value", password: undefined }],
  [
    "local",
    { remote: { url: REMOTE_URL, token: "remote-token", password: "remote-password" } },
    EMPTY_AUTH,
  ],
  [
    "remote",
    { remote: { url: REMOTE_URL }, auth: { mode: "token", token: ref("MISSING") } },
    EMPTY_AUTH,
  ],
] as const)("reads only %s surface credentials from %j", (mode, gateway, auth) => {
  expect(resolveGatewayProbeAuthSafe({ cfg: config({ mode, ...gateway }), mode, env: {} })).toEqual(
    { auth },
  );
});

it("keeps an unavailable local ref authoritative over remote plaintext in the synchronous path", () => {
  const result = resolveGatewayProbeAuthSafe({
    cfg: config({
      auth: { mode: "token", token: ref("MISSING") },
      remote: { token: "remote-token" },
    }),
    mode: "local",
    env: {},
  });
  expect(result.auth).toStrictEqual({});
  expect(result.warning).toContain("gateway.auth.token");
  expect(result.warning).toContain("unresolved");
});

it.each([undefined, REMOTE_URL])("selects the probe surface for remote URL %s", (url) => {
  expect(resolveGatewayProbeTarget({ gateway: { mode: "remote", remote: { url } } })).toEqual({
    gatewayMode: "remote",
    mode: url ? "remote" : "local",
    remoteUrlMissing: !url,
  });
});

it.each(["config-first", "env-first"] as const)(
  "reports redacted refs with identity and recovery under %s precedence",
  async (localPrecedence) => {
    const result = await resolveGatewayProbeAuthSafeWithSecretInputs(
      local(
        { mode: "token", token: ref("GATEWAY_SECRET") },
        { localPrecedence, env: { GATEWAY_SECRET: REDACTED_SENTINEL, ...AMBIENT_AUTH } },
      ),
    );
    expect(result.auth).toEqual({});
    expect(result.warningCode).toBe("SECRET_REF_REDACTED_VALUE");
    for (const detail of [
      "env:default:GATEWAY_SECRET",
      "redaction placeholder",
      "openclaw doctor --fix",
    ]) {
      expect(result.warning).toContain(detail);
    }
  },
);

it.each([
  ["token", "configured-token", "ambient-token"],
  ["password", "configured-password", "ambient-password"],
  ["token", ref("PROBE_SECRET"), "resolved-secret"],
  ["password", ref("PROBE_SECRET"), "resolved-secret"],
] as const)("keeps env-first %s precedence for %j", async (mode, value, expected) => {
  const result = await resolveGatewayProbeAuthSafeWithSecretInputs(
    envFirst({ mode, [mode]: value }),
  );
  expect(result.warning).toBeUndefined();
  expect(result.auth[mode]).toBe(expected);
});

it.each<ProbeCase>([
  [
    "unavailable token",
    envFirst({ mode: "token", token: ref("MISSING") }),
    {},
    ["gateway.auth.token"],
  ],
  [
    "unavailable password",
    envFirst({ mode: "password", password: ref("MISSING") }),
    {},
    ["gateway.auth.password"],
  ],
  [
    "implicit password ref",
    local(
      { password: ref("MISSING") },
      {
        localPrecedence: "env-first",
        env: { OPENCLAW_GATEWAY_TOKEN: "ambient-token" },
      },
    ),
    {},
    ["gateway.auth.password"],
  ],
  [
    "unresolved async ref",
    local({ mode: "token", token: ref("MISSING") }),
    {},
    ["gateway.auth.token", "unresolved"],
  ],
  ["remote token ref", remote({ token: ref("REMOTE") }), { token: "remote", password: undefined }],
  ["remote password", remote({ password: "remote" }), { token: undefined, password: "remote" }],
  [
    "unavailable remote token",
    remote({ token: ref("MISSING") }),
    {},
    ["gateway.remote.token SecretRef is unresolved"],
  ],
  [
    "unavailable remote password",
    remote({ password: ref("MISSING") }),
    {},
    ["gateway.remote.password SecretRef is unresolved"],
  ],
  [
    "remote password survives sibling failure",
    remote({ token: ref("MISSING"), password: "remote" }),
    { token: undefined, password: "remote" },
    ["gateway.remote.token SecretRef is unresolved"],
  ],
  [
    "remote probe ignores local password",
    {
      cfg: config({
        mode: "remote",
        auth: { mode: "password", password: ref("LOCAL") },
        remote: { url: REMOTE_URL, token: "remote-token" },
      }),
      mode: "remote",
      env: { LOCAL: "local-password" },
    },
    { token: "remote-token", password: undefined },
  ],
  [
    "CLI URL override excludes ambient auth",
    {
      ...remote({}),
      urlOverride: "wss://override.example",
      urlOverrideSource: "cli",
      env: { OPENCLAW_GATEWAY_PASSWORD: "ambient-password" },
    },
    {},
  ],
])("%s", async (_name, input, auth, warnings) => {
  const result = await resolveGatewayProbeAuthSafeWithSecretInputs(input);
  if (!warnings) {
    expect(result).toEqual({ auth });
    return;
  }
  expect(result.auth).toStrictEqual(auth);
  for (const warning of warnings) {
    expect(result.warning).toContain(warning);
  }
});
