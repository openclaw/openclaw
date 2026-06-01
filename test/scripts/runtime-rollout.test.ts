import { describe, expect, it } from "vitest";
import {
  isTransientRolloutCode,
  outcomeFromTenantImageResponse,
  tenantIdsFromFlyApps,
  tenantImageRequestBody,
} from "../../scripts/runtime-rollout.mjs";

describe("scripts/runtime-rollout", () => {
  it("treats Cloudflare 524 and connection failures as transient rollout errors", () => {
    expect(isTransientRolloutCode("000")).toBe(true);
    expect(isTransientRolloutCode("524")).toBe(true);
    expect(isTransientRolloutCode("500")).toBe(false);
    expect(isTransientRolloutCode("401")).toBe(false);
  });

  it("extracts sorted tenant ids from Fly app listings", () => {
    expect(
      tenantIdsFromFlyApps({
        apps: [
          { name: "rockielab-tenant-t-bravo" },
          { app_name: "rockielab-tenant-t-alpha" },
          { name: "rockielab-api" },
          { name: "rockielab-tenant-t-alpha" },
        ],
      }),
    ).toEqual(["t-alpha", "t-bravo"]);
  });

  it("only sends image in direct tenant fallback requests", () => {
    const body = JSON.parse(
      tenantImageRequestBody(
        "ghcr.io/saml212/rockielab-runtime-multitenant:e09f57bb7cdee9ebfeff457ad7e750f65539ec33",
      ),
    );

    expect(body).toEqual({
      image:
        "ghcr.io/saml212/rockielab-runtime-multitenant:e09f57bb7cdee9ebfeff457ad7e750f65539ec33",
    });
    expect(body).not.toHaveProperty("mode");
    expect(body).not.toHaveProperty("binary");
  });

  it("buckets tenant image endpoint responses", () => {
    expect(
      outcomeFromTenantImageResponse({
        code: "200",
        body: JSON.stringify({ updated: [{ id: "machine-1" }], skipped: [] }),
      }),
    ).toBe("updated");
    expect(
      outcomeFromTenantImageResponse({
        code: "200",
        body: JSON.stringify({ updated: [], skipped: [{ id: "machine-1" }] }),
      }),
    ).toBe("skipped");
    expect(outcomeFromTenantImageResponse({ code: "524", body: "error code: 524" })).toBe("failed");
  });
});
