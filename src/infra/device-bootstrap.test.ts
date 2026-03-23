import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  clearDeviceBootstrapTokens,
  DEVICE_BOOTSTRAP_TOKEN_TTL_MS,
  issueDeviceBootstrapToken,
  revokeDeviceBootstrapToken,
  verifyDeviceBootstrapToken,
} from "./device-bootstrap.js";

const tempDirs = createTrackedTempDirs();
const createTempDir = () => tempDirs.make("openclaw-device-bootstrap-test-");

function resolveBootstrapPath(baseDir: string): string {
  return path.join(baseDir, "devices", "bootstrap.json");
}

async function verifyBootstrapToken(
  baseDir: string,
  token: string,
  overrides: Partial<Parameters<typeof verifyDeviceBootstrapToken>[0]> = {},
) {
  return await verifyDeviceBootstrapToken({
    token,
    deviceId: "device-123",
    publicKey: "public-key-123",
    role: "node",
    scopes: [],
    baseDir,
    ...overrides,
  });
}

afterEach(async () => {
  vi.useRealTimers();
  await tempDirs.cleanup();
});

describe("device bootstrap tokens", () => {
  it("issues bootstrap tokens and persists them with an expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T12:00:00Z"));

    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({ baseDir });

    expect(issued.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(issued.expiresAtMs).toBe(Date.now() + DEVICE_BOOTSTRAP_TOKEN_TTL_MS);

    const raw = await fs.readFile(resolveBootstrapPath(baseDir), "utf8");
    const parsed = JSON.parse(raw) as Record<
      string,
      {
        token: string;
        ts: number;
        issuedAtMs: number;
        profile: { roles: string[]; scopes: string[] };
      }
    >;
    expect(parsed[issued.token]).toMatchObject({
      token: issued.token,
      ts: Date.now(),
      issuedAtMs: Date.now(),
      profile: {
        roles: ["node"],
        scopes: [],
      },
    });
  });

  it("verifies valid bootstrap tokens once and deletes them after success", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({ baseDir });

    await expect(verifyBootstrapToken(baseDir, issued.token)).resolves.toEqual({ ok: true });

    await expect(verifyBootstrapToken(baseDir, issued.token)).resolves.toEqual({
      ok: false,
      reason: "bootstrap_token_invalid",
    });

    await expect(fs.readFile(resolveBootstrapPath(baseDir), "utf8")).resolves.toBe("{}");
  });

  it("clears outstanding bootstrap tokens on demand", async () => {
    const baseDir = await createTempDir();
    const first = await issueDeviceBootstrapToken({ baseDir });
    const second = await issueDeviceBootstrapToken({ baseDir });

    await expect(clearDeviceBootstrapTokens({ baseDir })).resolves.toEqual({ removed: 2 });
    await expect(fs.readFile(resolveBootstrapPath(baseDir), "utf8")).resolves.toBe("{}");

    await expect(verifyBootstrapToken(baseDir, first.token)).resolves.toEqual({
      ok: false,
      reason: "bootstrap_token_invalid",
    });

    await expect(verifyBootstrapToken(baseDir, second.token)).resolves.toEqual({
      ok: false,
      reason: "bootstrap_token_invalid",
    });
  });

  it("revokes a specific bootstrap token", async () => {
    const baseDir = await createTempDir();
    const first = await issueDeviceBootstrapToken({ baseDir });
    const second = await issueDeviceBootstrapToken({ baseDir });

    await expect(revokeDeviceBootstrapToken({ baseDir, token: first.token })).resolves.toEqual({
      removed: true,
    });

    await expect(verifyBootstrapToken(baseDir, first.token)).resolves.toEqual({
      ok: false,
      reason: "bootstrap_token_invalid",
    });

    await expect(verifyBootstrapToken(baseDir, second.token)).resolves.toEqual({ ok: true });
  });

  it("consumes bootstrap tokens by the persisted map key", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({ baseDir });
    const issuedAtMs = Date.now();
    const bootstrapPath = path.join(baseDir, "devices", "bootstrap.json");
    await fs.writeFile(
      bootstrapPath,
      JSON.stringify(
        {
          "legacy-key": {
            token: issued.token,
            ts: issuedAtMs,
            issuedAtMs,
            profile: {
              roles: ["node"],
              scopes: [],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await expect(verifyBootstrapToken(baseDir, issued.token)).resolves.toEqual({ ok: true });

    await expect(fs.readFile(bootstrapPath, "utf8")).resolves.toBe("{}");
  });

  it("keeps the token when required verification fields are blank", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({ baseDir });

    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        role: "   ",
      }),
    ).resolves.toEqual({ ok: false, reason: "bootstrap_token_invalid" });

    const raw = await fs.readFile(resolveBootstrapPath(baseDir), "utf8");
    expect(raw).toContain(issued.token);
  });

  it("rejects bootstrap verification when role or scopes exceed the issued profile", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({ baseDir });

    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        role: "operator",
        scopes: ["operator.admin"],
      }),
    ).resolves.toEqual({ ok: false, reason: "bootstrap_token_invalid" });

    const raw = await fs.readFile(resolveBootstrapPath(baseDir), "utf8");
    expect(raw).toContain(issued.token);
  });

  it("supports explicitly bound bootstrap profiles", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({
      baseDir,
      profile: {
        roles: [" operator ", "operator"],
        scopes: ["operator.read", " operator.read "],
      },
    });

    const raw = await fs.readFile(resolveBootstrapPath(baseDir), "utf8");
    const parsed = JSON.parse(raw) as Record<
      string,
      { profile: { roles: string[]; scopes: string[] } }
    >;
    expect(parsed[issued.token]?.profile).toEqual({
      roles: ["operator"],
      scopes: ["operator.read"],
    });

    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        role: "operator",
        scopes: ["operator.read"],
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("accepts trimmed bootstrap tokens and still consumes them once", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({ baseDir });

    await expect(verifyBootstrapToken(baseDir, `  ${issued.token}  `)).resolves.toEqual({
      ok: true,
    });

    await expect(fs.readFile(resolveBootstrapPath(baseDir), "utf8")).resolves.toBe("{}");
  });

  it("rejects blank or unknown tokens", async () => {
    const baseDir = await createTempDir();
    await issueDeviceBootstrapToken({ baseDir });

    await expect(verifyBootstrapToken(baseDir, "   ")).resolves.toEqual({
      ok: false,
      reason: "bootstrap_token_invalid",
    });

    await expect(
      verifyDeviceBootstrapToken({
        token: "missing-token",
        deviceId: "device-123",
        publicKey: "public-key-123",
        role: "node",
        scopes: [],
        baseDir,
      }),
    ).resolves.toEqual({ ok: false, reason: "bootstrap_token_invalid" });
  });

  it("repairs malformed persisted state when issuing a new token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T12:00:00Z"));

    const baseDir = await createTempDir();
    const bootstrapPath = resolveBootstrapPath(baseDir);
    await fs.mkdir(path.dirname(bootstrapPath), { recursive: true });
    await fs.writeFile(bootstrapPath, "[1,2,3]\n", "utf8");

    const issued = await issueDeviceBootstrapToken({ baseDir });
    const raw = await fs.readFile(bootstrapPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, { token: string }>;

    expect(Object.keys(parsed)).toEqual([issued.token]);
    expect(parsed[issued.token]?.token).toBe(issued.token);
  });

  it("fails closed for unbound legacy records and prunes expired tokens", async () => {
    vi.useFakeTimers();
    const baseDir = await createTempDir();
    const bootstrapPath = resolveBootstrapPath(baseDir);
    await fs.mkdir(path.dirname(bootstrapPath), { recursive: true });

    vi.setSystemTime(new Date("2026-03-14T12:00:00Z"));
    await fs.writeFile(
      bootstrapPath,
      `${JSON.stringify(
        {
          legacyToken: {
            token: "legacyToken",
            issuedAtMs: Date.now(),
          },
          expiredToken: {
            token: "expiredToken",
            issuedAtMs: Date.now() - DEVICE_BOOTSTRAP_TOKEN_TTL_MS - 1,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expect(verifyBootstrapToken(baseDir, "legacyToken")).resolves.toEqual({
      ok: false,
      reason: "bootstrap_token_invalid",
    });

    await expect(verifyBootstrapToken(baseDir, "expiredToken")).resolves.toEqual({
      ok: false,
      reason: "bootstrap_token_invalid",
    });
  });
});
