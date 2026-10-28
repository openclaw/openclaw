import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { validateGitLabOAuthConfig } from "../agents/gitlab-host.js";
import { fingerprintGitLabOAuthConfig } from "./gitlab-oauth-config-fingerprint.js";

it("binds only validated public application fields and preserves pending setup fingerprints", () => {
  const config = validateGitLabOAuthConfig({
    issuer: "https://gitlab.example.test",
    clientId: "public-client",
    redirectUri: "https://gateway.example.test/oauth/gitlab/callback",
  });
  const expected = createHash("sha256").update(JSON.stringify(config)).digest("hex");
  expect(fingerprintGitLabOAuthConfig(config)).toBe(expected);
  expect(fingerprintGitLabOAuthConfig({ ...config, extra: "unrelated" } as typeof config)).toBe(
    expected,
  );
  for (const field of ["issuer", "clientId", "redirectUri"] as const) {
    expect(
      fingerprintGitLabOAuthConfig({ ...config, [field]: `${config[field]}-changed` }),
    ).not.toBe(expected);
  }
});
