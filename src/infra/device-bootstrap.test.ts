import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEVICE_BOOTSTRAP_TOKEN_TTL_MS,
  issueDeviceBootstrapToken,
  verifyDeviceBootstrapToken,
} from "./device-bootstrap.js";

const tempRoots: string[] = [];

async function createBaseDir(): Promise<string> {
  const baseDir = await mkdtemp(join(tmpdir(), "openclaw-device-bootstrap-"));
  tempRoots.push(baseDir);
  return baseDir;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    tempRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("device bootstrap tokens", () => {
  it("binds the first successful verification to a device identity", async () => {
    const baseDir = await createBaseDir();
    const issued = await issueDeviceBootstrapToken({ baseDir });

    await expect(
      verifyDeviceBootstrapToken({
        token: issued.token,
        deviceId: "device-1",
        publicKey: "pub-1",
        role: "node",
        scopes: ["node.invoke"],
        baseDir,
      }),
    ).resolves.toEqual({ ok: true });

    await expect(
      verifyDeviceBootstrapToken({
        token: issued.token,
        deviceId: "device-1",
        publicKey: "pub-1",
        role: "operator",
        scopes: ["operator.read"],
        baseDir,
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("rejects reuse from a different device after binding", async () => {
    const baseDir = await createBaseDir();
    const issued = await issueDeviceBootstrapToken({ baseDir });

    await verifyDeviceBootstrapToken({
      token: issued.token,
      deviceId: "device-1",
      publicKey: "pub-1",
      role: "node",
      scopes: ["node.invoke"],
      baseDir,
    });

    await expect(
      verifyDeviceBootstrapToken({
        token: issued.token,
        deviceId: "device-2",
        publicKey: "pub-2",
        role: "node",
        scopes: ["node.invoke"],
        baseDir,
      }),
    ).resolves.toEqual({ ok: false, reason: "bootstrap_token_invalid" });
  });

  it("expires bootstrap tokens after the ttl window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-12T10:00:00Z"));
    const baseDir = await createBaseDir();
    const issued = await issueDeviceBootstrapToken({ baseDir });

    vi.setSystemTime(new Date(Date.now() + DEVICE_BOOTSTRAP_TOKEN_TTL_MS + 1));

    await expect(
      verifyDeviceBootstrapToken({
        token: issued.token,
        deviceId: "device-1",
        publicKey: "pub-1",
        role: "node",
        scopes: ["node.invoke"],
        baseDir,
      }),
    ).resolves.toEqual({ ok: false, reason: "bootstrap_token_invalid" });
  });

  it("persists only token state that verification actually consumes", async () => {
    const baseDir = await createBaseDir();
    const issued = await issueDeviceBootstrapToken({ baseDir });
    const raw = await readFile(join(baseDir, "devices", "bootstrap.json"), "utf8");
    const state = JSON.parse(raw) as Record<string, Record<string, unknown>>;
    const record = state[issued.token];

    expect(record).toMatchObject({
      token: issued.token,
    });
    expect(record).not.toHaveProperty("channel");
    expect(record).not.toHaveProperty("senderId");
    expect(record).not.toHaveProperty("accountId");
    expect(record).not.toHaveProperty("threadId");
  });
});
