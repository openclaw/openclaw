import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  adminRolloutPollRequestHeaders,
  adminRolloutPollUrl,
  adminRolloutRequestHeaders,
  adminRolloutUrl,
  adminTenantFallbackRequestHeaders,
  adminTenantFallbackUrl,
  expectedAcknowledgedRolloutOptions,
  hasScopedRolloutOptions,
  isTransientRolloutCode,
  outcomeFromTenantAdminRolloutResponse,
  preflightGhcrImagePull,
  runRollout,
  rolloutOptionsFromEnv,
  tenantIdsFromFlyApps,
  validateAcknowledgedRolloutOptions,
} from "../../scripts/runtime-rollout.mjs";

const ROLLOUT_ENV_NAMES = [
  "API_URL",
  "ADMIN_TOKEN",
  "IMAGE_TAG",
  "ROLLOUT_ARTIFACT_DIR",
  "ROLLOUT_MAX_ATTEMPTS",
  "ROLLOUT_FALLBACK_AFTER_TRANSIENTS",
  "ROLLOUT_CURL_MAX_TIME",
  "ROLLOUT_TENANT_ID",
  "ROLLOUT_CANARY_COUNT",
  "ROLLOUT_CANARY_WAIT_SEC",
  "ROLLOUT_WAVE_DELAY_SEC",
  "ROLLOUT_WAVE_SIZE",
  "FLY_API_TOKEN",
  "FLY_ORG_SLUG",
  "FLY_MACHINES_API",
  "GHCR_PULL_USERNAME",
  "GHCR_PULL_TOKEN",
  "GITHUB_TOKEN",
  "GITHUB_REPOSITORY",
  "GITHUB_RUN_NUMBER",
  "API_PASSWORD",
] as const;

function snapshotEnv() {
  return new Map(ROLLOUT_ENV_NAMES.map((name) => [name, process.env[name]]));
}

function restoreEnv(previous: Map<string, string | undefined>) {
  for (const name of ROLLOUT_ENV_NAMES) {
    const value = previous.get(name);
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

async function readRolloutSummary(dir: string) {
  return JSON.parse(await readFile(path.join(dir, "rollout-summary.json"), "utf8"));
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status });
}

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

  it("sends only X-Admin-Token on rollout POST, poll GET, and fallback POST", () => {
    expect(adminRolloutRequestHeaders("admin-token")).toEqual({
      "X-Admin-Token": "admin-token",
      Accept: "application/json",
    });
    expect(adminRolloutRequestHeaders("admin-token")).not.toHaveProperty("Authorization");
    expect(adminRolloutPollRequestHeaders("admin-token")).not.toHaveProperty("Authorization");
    expect(adminTenantFallbackRequestHeaders("admin-token")).not.toHaveProperty("Authorization");
  });

  it("buckets per-tenant admin rollout responses", () => {
    expect(
      outcomeFromTenantAdminRolloutResponse({
        code: "200",
        body: JSON.stringify({ updated: [{ id: "machine-1" }], skipped: [] }),
      }),
    ).toBe("updated");
    expect(
      outcomeFromTenantAdminRolloutResponse({
        code: "200",
        body: JSON.stringify({ updated: [], skipped: [{ id: "machine-1" }] }),
      }),
    ).toBe("skipped");
    expect(
      outcomeFromTenantAdminRolloutResponse({
        code: "200",
        body: JSON.stringify({ state: "aborted" }),
      }),
    ).toBe("failed");
    expect(
      outcomeFromTenantAdminRolloutResponse({
        code: "200",
        body: JSON.stringify({ failed: [{ tenant_id: "t-demo" }] }),
      }),
    ).toBe("failed");
    expect(outcomeFromTenantAdminRolloutResponse({ code: "524", body: "error code: 524" })).toBe(
      "failed",
    );
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
      "https://api.rockielab.com/api/admin/tenants/rollout?image=ghcr.io%2Fimg%3Asha&confirm=true&tenant_id=t-demo&canary_count=1&canary_wait_sec=30&wave_delay_sec=45&wave_size=2&async=true",
    );
  });

  it("builds initial admin rollout urls with confirm and async enabled", () => {
    expect(adminRolloutUrl("https://api.rockielab.com", "ghcr.io/img:sha")).toBe(
      "https://api.rockielab.com/api/admin/tenants/rollout?image=ghcr.io%2Fimg%3Asha&confirm=true&async=true",
    );
  });

  it("opts out of async mode when asyncMode=false is passed", () => {
    // Back-compat hatch for any caller that wants the legacy
    // synchronous POST shape (small fleets, one-off curl from a
    // laptop). The default is async=true since #1061.
    const url = adminRolloutUrl("https://api.rockielab.com", "ghcr.io/img:sha", {
      asyncMode: false,
    });
    expect(url).toBe(
      "https://api.rockielab.com/api/admin/tenants/rollout?image=ghcr.io%2Fimg%3Asha&confirm=true&async=false",
    );
  });

  it("builds per-tenant fallback URLs against the admin rollout route", () => {
    expect(adminTenantFallbackUrl("https://api.rockielab.com", "ghcr.io/img:sha", "t-demo")).toBe(
      "https://api.rockielab.com/api/admin/tenants/rollout?image=ghcr.io%2Fimg%3Asha&confirm=true&tenant_id=t-demo&canary_count=0&canary_wait_sec=0&wave_delay_sec=0&async=false",
    );
  });

  it("builds the async rollout poll URL with URL-safe encoding", () => {
    // CI uses this to GET the status of an in-flight rollout job.
    // The rollout_id is a uuid hex (no special chars) but we
    // encodeURIComponent defensively in case the upstream format
    // ever changes.
    expect(adminRolloutPollUrl("https://api.rockielab.com", "abc123def456")).toBe(
      "https://api.rockielab.com/api/admin/tenants/rollout/abc123def456",
    );
    expect(adminRolloutPollUrl("https://api.rockielab.com", "id with/slash")).toBe(
      "https://api.rockielab.com/api/admin/tenants/rollout/id%20with%2Fslash",
    );
  });

  it("preflights GHCR private image readability before touching tenants", async () => {
    const attempts: unknown[] = [];
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
        const requestUrl = String(url);
        fetchCalls.push({ url: requestUrl, init });
        if (requestUrl.startsWith("https://ghcr.io/token?")) {
          return jsonResponse(200, { token: "registry-token" });
        }
        if (
          requestUrl === "https://ghcr.io/v2/rockielab/rockielab-runtime-multitenant/manifests/sha"
        ) {
          return jsonResponse(401, { errors: [{ code: "UNAUTHORIZED" }] });
        }
        throw new Error(`unexpected fetch: ${requestUrl}`);
      }),
    );

    try {
      const result = await preflightGhcrImagePull({
        image: "ghcr.io/rockielab/rockielab-runtime-multitenant:sha",
        username: "saml212",
        token: "",
        timeoutMs: 1000,
        attempts,
      });

      expect(result).toMatchObject({
        ok: false,
        auth_mode: "anonymous",
        code: "401",
        repository: "rockielab/rockielab-runtime-multitenant",
        reference: "sha",
      });
      expect(result.message).toContain("GHCR_PULL_TOKEN is not set");
      expect(fetchCalls[0]?.init?.headers).not.toHaveProperty("Authorization");
      expect(attempts).toMatchObject([
        { kind: "ghcr-pull-preflight-token", response_code: "200" },
        { kind: "ghcr-pull-preflight-manifest", response_code: "401" },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses the configured GHCR pull token during preflight", async () => {
    const attempts: unknown[] = [];
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
        const requestUrl = String(url);
        fetchCalls.push({ url: requestUrl, init });
        if (requestUrl.startsWith("https://ghcr.io/token?")) {
          return jsonResponse(200, { token: "registry-token" });
        }
        if (
          requestUrl === "https://ghcr.io/v2/rockielab/rockielab-runtime-multitenant/manifests/sha"
        ) {
          return jsonResponse(200, { schemaVersion: 2 });
        }
        throw new Error(`unexpected fetch: ${requestUrl}`);
      }),
    );

    try {
      await expect(
        preflightGhcrImagePull({
          image: "ghcr.io/rockielab/rockielab-runtime-multitenant:sha",
          username: "saml212",
          token: "pull-token",
          timeoutMs: 1000,
          attempts,
        }),
      ).resolves.toMatchObject({
        ok: true,
        auth_mode: "configured-token",
        code: "200",
      });
      expect(fetchCalls[0]?.init?.headers).toMatchObject({
        Authorization: `Basic ${Buffer.from("saml212:pull-token").toString("base64")}`,
      });
      expect(fetchCalls[1]?.init?.headers).toMatchObject({
        Authorization: "Bearer registry-token",
      });
      expect(JSON.stringify(attempts)).not.toContain("registry-token");
      expect(JSON.stringify(attempts)).toContain("<redacted>");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stops rollout before admin calls when the namespaced GHCR image is unreadable", async () => {
    const previousEnv = snapshotEnv();
    const artifactDir = await mkdtemp(path.join(tmpdir(), "runtime-rollout-"));
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    try {
      process.env.API_URL = "https://api.rockielab.test";
      process.env.ADMIN_TOKEN = "admin-token";
      process.env.IMAGE_TAG = "ghcr.io/rockielab/rockielab-runtime-multitenant:sha";
      process.env.ROLLOUT_ARTIFACT_DIR = artifactDir;
      process.env.ROLLOUT_CURL_MAX_TIME = "1";
      process.env.GHCR_PULL_USERNAME = "saml212";
      process.env.GHCR_PULL_TOKEN = "pull-token";
      delete process.env.FLY_API_TOKEN;
      delete process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_REPOSITORY;
      delete process.env.GITHUB_RUN_NUMBER;
      delete process.env.API_PASSWORD;

      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
          const requestUrl = String(url);
          fetchCalls.push({ url: requestUrl, init });
          if (requestUrl.startsWith("https://ghcr.io/token?")) {
            return jsonResponse(200, { token: "registry-token", expires_in: 300 });
          }
          if (
            requestUrl ===
            "https://ghcr.io/v2/rockielab/rockielab-runtime-multitenant/manifests/sha"
          ) {
            return jsonResponse(401, { errors: [{ code: "UNAUTHORIZED" }] });
          }
          throw new Error(`unexpected fetch: ${requestUrl}`);
        }),
      );

      await expect(runRollout()).resolves.toBe(1);

      expect(fetchCalls.map((call) => call.url)).toEqual([
        "https://ghcr.io/token?service=ghcr.io&scope=repository%3Arockielab%2Frockielab-runtime-multitenant%3Apull",
        "https://ghcr.io/v2/rockielab/rockielab-runtime-multitenant/manifests/sha",
      ]);
      expect(fetchCalls.some((call) => call.url.startsWith("https://api.rockielab.test"))).toBe(
        false,
      );

      const summary = await readRolloutSummary(artifactDir);
      expect(summary).toMatchObject({
        final_result: "failed-ghcr-pull-auth-preflight",
        final_response_code: "401",
        ghcr_pull_preflight: {
          ok: false,
          auth_mode: "configured-token",
          code: "401",
          repository: "rockielab/rockielab-runtime-multitenant",
          reference: "sha",
        },
      });
      expect(summary.error_details.remediation).toContain("Set GHCR_PULL_TOKEN");
      const summaryText = JSON.stringify(summary);
      const attemptsText = await readFile(path.join(artifactDir, "attempts.jsonl"), "utf8");
      const attempts = attemptsText
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(summaryText).not.toContain("registry-token");
      expect(attemptsText).not.toContain("registry-token");
      expect(JSON.parse(attempts[0].response_body)).toMatchObject({
        token: "<redacted>",
        expires_in: 300,
      });
    } finally {
      vi.unstubAllGlobals();
      restoreEnv(previousEnv);
      await rm(artifactDir, { recursive: true, force: true });
    }
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

  it("falls back per tenant after transient admin rollout responses without Authorization", async () => {
    const previousEnv = snapshotEnv();
    const artifactDir = await mkdtemp(path.join(tmpdir(), "runtime-rollout-"));
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    try {
      process.env.API_URL = "https://api.rockielab.test";
      process.env.ADMIN_TOKEN = "admin-token";
      process.env.IMAGE_TAG = "ghcr.io/img:sha";
      process.env.ROLLOUT_ARTIFACT_DIR = artifactDir;
      process.env.ROLLOUT_MAX_ATTEMPTS = "5";
      process.env.ROLLOUT_FALLBACK_AFTER_TRANSIENTS = "2";
      process.env.ROLLOUT_CURL_MAX_TIME = "1";
      process.env.FLY_API_TOKEN = "fly-token";
      process.env.FLY_ORG_SLUG = "test-org";
      process.env.FLY_MACHINES_API = "https://api.machines.test/v1";
      process.env.API_PASSWORD = "wrong-password";
      delete process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_REPOSITORY;
      delete process.env.GITHUB_RUN_NUMBER;

      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
          const requestUrl = String(url);
          fetchCalls.push({ url: requestUrl, init });
          const parsed = new URL(requestUrl);
          if (
            init?.method === "POST" &&
            parsed.pathname === "/api/admin/tenants/rollout" &&
            !parsed.searchParams.has("tenant_id")
          ) {
            return new Response("error code: 524", { status: 524 });
          }
          if (
            init?.method === "GET" &&
            requestUrl === "https://api.machines.test/v1/apps?org_slug=test-org"
          ) {
            return jsonResponse(200, {
              apps: [{ name: "rockielab-tenant-t-alpha" }, { name: "rockielab-api" }],
            });
          }
          if (
            init?.method === "POST" &&
            parsed.pathname === "/api/admin/tenants/rollout" &&
            parsed.searchParams.get("tenant_id") === "t-alpha"
          ) {
            return jsonResponse(200, {
              updated: [{ tenant_id: "t-alpha", machine_id: "machine-1" }],
              skipped: [],
              failed: [],
            });
          }
          throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${requestUrl}`);
        }),
      );

      await expect(runRollout()).resolves.toBe(0);

      const initialAdminCalls = fetchCalls.filter((call) => {
        const url = new URL(call.url);
        return (
          call.init?.method === "POST" &&
          url.pathname === "/api/admin/tenants/rollout" &&
          !url.searchParams.has("tenant_id")
        );
      });
      expect(initialAdminCalls).toHaveLength(2);
      const fallbackCall = fetchCalls.find((call) => call.url.includes("tenant_id=t-alpha"));
      expect(fallbackCall, "expected per-tenant fallback request").toBeDefined();
      expect(fallbackCall!.url).toBe(
        "https://api.rockielab.test/api/admin/tenants/rollout?image=ghcr.io%2Fimg%3Asha&confirm=true&tenant_id=t-alpha&canary_count=0&canary_wait_sec=0&wave_delay_sec=0&async=false",
      );
      expect(fallbackCall!.init?.headers).toMatchObject({
        "X-Admin-Token": "admin-token",
      });
      expect(fallbackCall!.init?.headers).not.toHaveProperty("Authorization");

      const summary = await readRolloutSummary(artifactDir);
      expect(summary.final_result).toBe("succeeded-via-per-tenant-fallback");
      expect(summary.buckets).toMatchObject({ updated: 1, skipped: 0, failed: 0, total: 1 });
      expect(summary.fallback).toMatchObject({
        strategy: "fly-app-list-plus-admin-tenant-rollout",
        tenant_ids: ["t-alpha"],
      });
    } finally {
      vi.unstubAllGlobals();
      restoreEnv(previousEnv);
      await rm(artifactDir, { recursive: true, force: true });
    }
  });

  it("returns failure when a final successful admin response reports failed tenants", async () => {
    const previousEnv = snapshotEnv();
    const artifactDir = await mkdtemp(path.join(tmpdir(), "runtime-rollout-"));
    try {
      process.env.API_URL = "https://api.rockielab.test";
      process.env.ADMIN_TOKEN = "admin-token";
      process.env.IMAGE_TAG = "ghcr.io/img:sha";
      process.env.ROLLOUT_ARTIFACT_DIR = artifactDir;
      process.env.ROLLOUT_MAX_ATTEMPTS = "1";
      process.env.ROLLOUT_CURL_MAX_TIME = "1";
      delete process.env.FLY_API_TOKEN;
      delete process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_REPOSITORY;
      delete process.env.GITHUB_RUN_NUMBER;
      delete process.env.API_PASSWORD;

      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          jsonResponse(200, {
            updated: [{ tenant_id: "t-updated" }],
            skipped: [{ tenant_id: "t-skipped" }],
            failed: [{ tenant_id: "t-failed" }],
            error_details: { "t-failed": "machine update failed" },
          }),
        ),
      );

      await expect(runRollout()).resolves.toBe(1);

      const summary = await readRolloutSummary(artifactDir);
      expect(summary.final_result).toBe("failed-tenants");
      expect(summary.final_response_code).toBe("200");
      expect(summary.buckets).toMatchObject({ updated: 1, skipped: 1, failed: 1, total: 3 });
      expect(summary.error_details).toEqual({ "t-failed": "machine update failed" });
    } finally {
      vi.unstubAllGlobals();
      restoreEnv(previousEnv);
      await rm(artifactDir, { recursive: true, force: true });
    }
  });
});
