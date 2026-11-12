import { describe, expect, it } from "vitest";
import { gitCoauthorOrganizationPolicy } from "../../packages/gateway-protocol/src/schema/git-coauthor-identity.js";
import type { GatewayAuthResult } from "./auth.js";
import { resolveTrustedProxyGitCoauthor } from "./trusted-proxy-git-coauthor.js";

const authConfig = {
  mode: "trusted-proxy" as const,
  trustedProxy: {
    userHeader: "x-occ-identity",
    gitCoauthor: {
      nameHeader: "x-credit-name",
      emailHeader: "x-credit-email",
      emailVerifiedHeader: "x-credit-email-verified",
    },
  },
};
const authResult: GatewayAuthResult = {
  ok: true,
  method: "trusted-proxy",
  user: "oidc:issuer:subject",
};
const headers = {
  "x-credit-name": "Alice Example",
  "x-credit-email": "alice@example.test",
  "x-credit-email-verified": "true",
};

describe("trusted proxy Git credit claims", () => {
  it("imports a complete pair only from an admitted configured proxy", () => {
    expect(
      resolveTrustedProxyGitCoauthor({
        authConfig,
        authResult,
        headers: {
          ...headers,
          "x-credit-name": " Alice Example ",
          "x-credit-email": " ALICE@example.test ",
        },
      }),
    ).toEqual({
      name: "Alice Example",
      email: "alice@example.test",
      policy: gitCoauthorOrganizationPolicy(
        authConfig.trustedProxy.userHeader,
        authConfig.trustedProxy.gitCoauthor,
      ),
    });
    expect(
      resolveTrustedProxyGitCoauthor({
        authConfig,
        authResult: { ok: true, method: "token" },
        headers,
      }),
    ).toBeUndefined();
    expect(
      resolveTrustedProxyGitCoauthor({ authConfig: undefined, authResult, headers }),
    ).toBeUndefined();
  });

  it.each([
    { ...headers, "x-credit-name": "" },
    { ...headers, "x-credit-email": "" },
    { ...headers, "x-credit-name": "Alice\nCo-authored-by: Mallory" },
    { ...headers, "x-credit-name": "Alice\u2028Other" },
    { ...headers, "x-credit-name": "Alice\u2029Other" },
    { ...headers, "x-credit-name": "Alice <Other>" },
    { ...headers, "x-credit-email": "alice@example.test\nOther" },
    { ...headers, "x-credit-email": "Alice <alice@example.test>" },
    { ...headers, "x-credit-email": "alice@example.test>" },
    { ...headers, "x-credit-email-verified": "false" },
    { ...headers, "x-credit-email-verified": undefined },
    { ...headers, "x-credit-email": ["alice@example.test", "mallory@example.test"] },
  ])("withholds partial, unverified or ambiguous claims: %j", (claims) => {
    expect(resolveTrustedProxyGitCoauthor({ authConfig, authResult, headers: claims })).toBeNull();
  });

  it("allows administrator-asserted email when no verification header is configured", () => {
    expect(
      resolveTrustedProxyGitCoauthor({
        authConfig: {
          ...authConfig,
          trustedProxy: {
            ...authConfig.trustedProxy,
            gitCoauthor: { nameHeader: "x-credit-name", emailHeader: "x-credit-email" },
          },
        },
        authResult,
        headers,
      }),
    ).toEqual({
      name: "Alice Example",
      email: "alice@example.test",
      policy: gitCoauthorOrganizationPolicy(authConfig.trustedProxy.userHeader, {
        nameHeader: "x-credit-name",
        emailHeader: "x-credit-email",
      }),
    });
  });
});
