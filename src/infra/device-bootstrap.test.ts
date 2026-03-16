import { mkdtemp, rm } from "node:fs/promises";
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
  it("accepts the first successful verification", async () => {
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
  });

  it("rejects replay after the first successful verification", async () => {
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
    ).resolves.toEqual({ ok: false, reason: "bootstrap_token_invalid" });
  });

  it("rejects reuse from a different device after consumption", async () => {
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
});
