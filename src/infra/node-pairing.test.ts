import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  approveNodePairing,
  getPairedNode,
  requestNodePairing,
  verifyNodeToken,
} from "./node-pairing.js";

async function setupPairedNode(baseDir: string): Promise<string> {
  const request = await requestNodePairing(
    {
      nodeId: "node-1",
      platform: "darwin",
      commands: ["system.run"],
    },
    baseDir,
  );
  await approveNodePairing(request.request.requestId, baseDir);
  const paired = await getPairedNode("node-1", baseDir);
  expect(paired).not.toBeNull();
  if (!paired) {
    throw new Error("expected node to be paired");
  }
  return paired.token;
}

describe("node pairing tokens", () => {
  test("reuses existing pending requests for the same node", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-node-pairing-"));
    const first = await requestNodePairing(
      {
        nodeId: "node-1",
        platform: "darwin",
      },
      baseDir,
    );
    const second = await requestNodePairing(
      {
        nodeId: "node-1",
        platform: "darwin",
      },
      baseDir,
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.request.requestId).toBe(first.request.requestId);
  });

  test("generates base64url node tokens with 256-bit entropy output length", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-node-pairing-"));
    const token = await setupPairedNode(baseDir);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
  });

  test("verifies token and rejects mismatches", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-node-pairing-"));
    const token = await setupPairedNode(baseDir);
    await expect(verifyNodeToken("node-1", token, baseDir)).resolves.toEqual({
      ok: true,
      node: expect.objectContaining({ nodeId: "node-1" }),
    });
    await expect(verifyNodeToken("node-1", "x".repeat(token.length), baseDir)).resolves.toEqual({
      ok: false,
    });
  });

  test("treats multibyte same-length token input as mismatch without throwing", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-node-pairing-"));
    const token = await setupPairedNode(baseDir);
    const multibyteToken = "é".repeat(token.length);
    expect(Buffer.from(multibyteToken).length).not.toBe(Buffer.from(token).length);

    await expect(verifyNodeToken("node-1", multibyteToken, baseDir)).resolves.toEqual({
      ok: false,
    });
  });
});
