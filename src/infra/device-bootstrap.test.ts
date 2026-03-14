import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  DEVICE_BOOTSTRAP_TOKEN_TTL_MS,
  issueDeviceBootstrapToken,
  verifyDeviceBootstrapToken,
} from "./device-bootstrap.js";

const tempDirs = createTrackedTempDirs();
const createTempDir = () => tempDirs.make("openclaw-device-bootstrap-test-");

function resolveBootstrapPath(baseDir: string): string {
  return path.join(baseDir, "devices", "bootstrap.json");
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
      { token: string; ts: number; issuedAtMs: number }
    >;
    expect(parsed[issued.token]).toMatchObject({
      token: issued.token,
      ts: Date.now(),
      issuedAtMs: Date.now(),
    });
  });

  it("verifies valid bootstrap tokens once and deletes them after success", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({ baseDir });

    await expect(
      verifyDeviceBootstrapToken({
        token: issued.token,
        deviceId: "device-123",
        publicKey: "public-key-123",
        role: "operator.admin",
        scopes: ["operator.admin"],
        baseDir,
      }),
    ).resolves.toEqual({ ok: true });

    await expect(
      verifyDeviceBootstrapToken({
        token: issued.token,
        deviceId: "device-123",
        publicKey: "public-key-123",
        role: "operator.admin",
        scopes: ["operator.admin"],
        baseDir,
      }),
    ).resolves.toEqual({ ok: false, reason: "bootstrap_token_invalid" });

    await expect(fs.readFile(resolveBootstrapPath(baseDir), "utf8")).resolves.toBe("{}");
  });

  it("keeps the token when required verification fields are blank", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({ baseDir });

    await expect(
      verifyDeviceBootstrapToken({
        token: issued.token,
        deviceId: "device-123",
        publicKey: "public-key-123",
        role: "   ",
        scopes: ["operator.admin"],
        baseDir,
      }),
    ).resolves.toEqual({ ok: false, reason: "bootstrap_token_invalid" });

    const raw = await fs.readFile(resolveBootstrapPath(baseDir), "utf8");
    expect(raw).toContain(issued.token);
  });

  it("accepts trimmed bootstrap tokens and still consumes them once", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({ baseDir });

    await expect(
      verifyDeviceBootstrapToken({
        token: `  ${issued.token}  `,
        deviceId: "device-123",
        publicKey: "public-key-123",
        role: "operator.admin",
        scopes: ["operator.admin"],
        baseDir,
      }),
    ).resolves.toEqual({ ok: true });

    await expect(fs.readFile(resolveBootstrapPath(baseDir), "utf8")).resolves.toBe("{}");
  });

  it("rejects blank or unknown tokens", async () => {
    const baseDir = await createTempDir();
    await issueDeviceBootstrapToken({ baseDir });

    await expect(
      verifyDeviceBootstrapToken({
        token: "   ",
        deviceId: "device-123",
        publicKey: "public-key-123",
        role: "operator.admin",
        scopes: ["operator.admin"],
        baseDir,
      }),
    ).resolves.toEqual({ ok: false, reason: "bootstrap_token_invalid" });

    await expect(
      verifyDeviceBootstrapToken({
        token: "missing-token",
        deviceId: "device-123",
        publicKey: "public-key-123",
        role: "operator.admin",
        scopes: ["operator.admin"],
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

  it("accepts legacy records that only stored issuedAtMs and prunes expired tokens", async () => {
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

    await expect(
      verifyDeviceBootstrapToken({
        token: "legacyToken",
        deviceId: "device-123",
        publicKey: "public-key-123",
        role: "operator.admin",
        scopes: ["operator.admin"],
        baseDir,
      }),
    ).resolves.toEqual({ ok: true });

    await expect(
      verifyDeviceBootstrapToken({
        token: "expiredToken",
        deviceId: "device-123",
        publicKey: "public-key-123",
        role: "operator.admin",
        scopes: ["operator.admin"],
        baseDir,
      }),
    ).resolves.toEqual({ ok: false, reason: "bootstrap_token_invalid" });
  });
});
