import { afterEach, describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { KILOCODE_ORG_ID_ENV_VAR, resolveKilocodeOrgId } from "./kilocode-shared.js";

describe("resolveKilocodeOrgId", () => {
  const envSnapshot = captureEnv([KILOCODE_ORG_ID_ENV_VAR]);

  afterEach(() => {
    envSnapshot.restore();
  });

  it("returns undefined when nothing is configured", () => {
    delete process.env[KILOCODE_ORG_ID_ENV_VAR];
    expect(resolveKilocodeOrgId()).toBeUndefined();
    expect(resolveKilocodeOrgId({})).toBeUndefined();
  });

  it("returns organizationId field when set (highest priority)", () => {
    process.env[KILOCODE_ORG_ID_ENV_VAR] = "env-org";
    expect(
      resolveKilocodeOrgId({
        organizationId: "field-org",
        headers: { "X-KILOCODE-ORGANIZATIONID": "header-org" },
      }),
    ).toBe("field-org");
  });

  it("trims whitespace from organizationId field", () => {
    expect(resolveKilocodeOrgId({ organizationId: "  field-org  " })).toBe("field-org");
  });

  it("skips empty/whitespace organizationId field and falls through to headers", () => {
    expect(
      resolveKilocodeOrgId({
        organizationId: "   ",
        headers: { "X-KILOCODE-ORGANIZATIONID": "header-org" },
      }),
    ).toBe("header-org");
  });

  it("returns header value when organizationId field is absent", () => {
    delete process.env[KILOCODE_ORG_ID_ENV_VAR];
    expect(resolveKilocodeOrgId({ headers: { "X-KILOCODE-ORGANIZATIONID": "header-org" } })).toBe(
      "header-org",
    );
  });

  it("headers take precedence over env var", () => {
    process.env[KILOCODE_ORG_ID_ENV_VAR] = "env-org";
    expect(resolveKilocodeOrgId({ headers: { "X-KILOCODE-ORGANIZATIONID": "header-org" } })).toBe(
      "header-org",
    );
  });

  it("returns env var when no provider config is given", () => {
    process.env[KILOCODE_ORG_ID_ENV_VAR] = "env-org";
    expect(resolveKilocodeOrgId()).toBe("env-org");
    expect(resolveKilocodeOrgId({})).toBe("env-org");
  });

  it("returns env var when providerConfig has no org identifiers", () => {
    process.env[KILOCODE_ORG_ID_ENV_VAR] = "env-org";
    expect(resolveKilocodeOrgId({ organizationId: undefined, headers: {} })).toBe("env-org");
  });

  it("returns undefined when env var is empty string", () => {
    process.env[KILOCODE_ORG_ID_ENV_VAR] = "";
    expect(resolveKilocodeOrgId()).toBeUndefined();
  });
});
