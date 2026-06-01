import { describe, expect, it } from "vitest";
import {
  adminRolloutUrl,
  expectedAcknowledgedRolloutOptions,
  hasScopedRolloutOptions,
  isTransientRolloutCode,
  outcomeFromTenantImageResponse,
  rolloutOptionsFromEnv,
  tenantIdsFromFlyApps,
  tenantImageRequestBody,
  tenantImageRequestHeaders,
  validateAcknowledgedRolloutOptions,
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

  it("sends both admin auth gates and only adds tenant token when present", () => {
    expect(tenantImageRequestHeaders("api-password", "admin-token")).toEqual({
      "X-Admin-Token": "admin-token",
      Authorization: "Bearer api-password",
      Accept: "application/json",
      "Content-Type": "application/json",
    });
    expect(tenantImageRequestHeaders("api-password", "admin-token", " tenant-dev-token ")).toEqual({
      "X-Admin-Token": "admin-token",
      Authorization: "Bearer api-password",
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Tenant-Token": "tenant-dev-token",
    });
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

  it("builds scoped admin rollout urls from manual rollout options", () => {
    const url = adminRolloutUrl("https://api.rockielab.com", "ghcr.io/img:sha", {
      tenantId: "t-demo",
      canaryCount: "1",
      canaryWaitSec: "30",
      waveDelaySec: "45",
      waveSize: "2",
    });

    expect(url).toBe(
      "https://api.rockielab.com/api/admin/tenants/rollout?image=ghcr.io%2Fimg%3Asha&tenant_id=t-demo&canary_count=1&canary_wait_sec=30&wave_delay_sec=45&wave_size=2",
    );
  });

  it("treats tenant and rollout tuning options as scoped to prevent fallback broadening", () => {
    expect(hasScopedRolloutOptions({ tenantId: "t-demo" })).toBe(true);
    expect(hasScopedRolloutOptions({ canaryCount: "1" })).toBe(true);
    expect(hasScopedRolloutOptions({ canaryWaitSec: "10" })).toBe(true);
    expect(hasScopedRolloutOptions({ waveDelaySec: "10" })).toBe(true);
    expect(hasScopedRolloutOptions({ waveSize: "2" })).toBe(true);
    expect(hasScopedRolloutOptions({})).toBe(false);
  });

  it("requires scoped rollout options to be acknowledged by the admin API", () => {
    const options = {
      tenantId: "t-demo",
      canaryCount: "1",
      canaryWaitSec: "30",
      waveDelaySec: "45",
      waveSize: "2",
    };

    expect(expectedAcknowledgedRolloutOptions(options)).toEqual({
      tenant_id: "t-demo",
      canary_count: 1,
      canary_wait_sec: 30,
      wave_delay_sec: 45,
      wave_size: 2,
    });
    expect(
      validateAcknowledgedRolloutOptions(options, {
        rollout_options: {
          tenant_id: "t-demo",
          canary_count: 1,
          canary_wait_sec: 30,
          wave_delay_sec: 45,
          wave_size: 2,
        },
      }),
    ).toEqual([]);
    expect(validateAcknowledgedRolloutOptions(options, {})).toEqual([
      "tenant_id: expected t-demo, got <missing>",
      "canary_count: expected 1, got <missing>",
      "canary_wait_sec: expected 30, got <missing>",
      "wave_delay_sec: expected 45, got <missing>",
      "wave_size: expected 2, got <missing>",
    ]);
  });

  it("reads rollout options from env without requiring workflow_dispatch", () => {
    const names = [
      "ROLLOUT_TENANT_ID",
      "ROLLOUT_CANARY_COUNT",
      "ROLLOUT_CANARY_WAIT_SEC",
      "ROLLOUT_WAVE_DELAY_SEC",
      "ROLLOUT_WAVE_SIZE",
    ];
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    try {
      process.env.ROLLOUT_TENANT_ID = "t-demo";
      process.env.ROLLOUT_CANARY_COUNT = "1";
      process.env.ROLLOUT_CANARY_WAIT_SEC = "30";
      process.env.ROLLOUT_WAVE_DELAY_SEC = "45";
      process.env.ROLLOUT_WAVE_SIZE = "2";

      expect(rolloutOptionsFromEnv()).toEqual({
        tenantId: "t-demo",
        canaryCount: "1",
        canaryWaitSec: "30",
        waveDelaySec: "45",
        waveSize: "2",
      });
    } finally {
      for (const name of names) {
        const value = previous.get(name);
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });
});
