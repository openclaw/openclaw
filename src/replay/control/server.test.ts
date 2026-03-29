import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as configModule from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getDeterministicFreePortBlock } from "../../test-utils/ports.js";
import { startReplayControlServer } from "./server.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function writeTrajectoryFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-replay-server-"));
  cleanupDirs.push(dir);
  const fixturePath = path.join(
    process.cwd(),
    "src",
    "research",
    "contracts",
    "__fixtures__",
    "trajectory",
    "v1",
    "small.json",
  );
  const raw = await fs.readFile(fixturePath, "utf8");
  const outPath = path.join(dir, "trajectory.v1.json");
  await fs.writeFile(outPath, raw, "utf8");
  return outPath;
}

describe("replay control server", () => {
  it("fails closed when research is disabled", async () => {
    await expect(startReplayControlServer({ enabled: false })).rejects.toThrow(
      /Replay control is disabled/,
    );
  });

  it("defaults enabled from loaded config when params.enabled is omitted", async () => {
    const spy = vi.spyOn(configModule, "loadConfig").mockReturnValue({
      research: { enabled: true },
    } as OpenClawConfig);
    const port = await getDeterministicFreePortBlock({ offsets: [50] });
    let server: Awaited<ReturnType<typeof startReplayControlServer>> | undefined;
    try {
      server = await startReplayControlServer({ port });
      expect(server.port).toBe(port);
    } finally {
      await server?.close();
      spy.mockRestore();
    }
  });

  it("defaults to disabled when config has research disabled", async () => {
    const spy = vi.spyOn(configModule, "loadConfig").mockReturnValue({
      research: { enabled: false },
    } as OpenClawConfig);
    try {
      await expect(startReplayControlServer({})).rejects.toThrow(/Replay control is disabled/);
    } finally {
      spy.mockRestore();
    }
  });

  it("requires bearer token and supports lifecycle endpoints", async () => {
    const trajectoryPath = await writeTrajectoryFixture();
    const port = await getDeterministicFreePortBlock({ offsets: [0] });
    const server = await startReplayControlServer({
      enabled: true,
      port,
      token: "test-token",
    });
    try {
      const unauth = await fetch(`http://127.0.0.1:${server.port}/api/replay/v1/runs.create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trajectoryPath, mode: "recorded" }),
      });
      expect(unauth.status).toBe(401);

      const createRes = await fetch(`http://127.0.0.1:${server.port}/api/replay/v1/runs.create`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ trajectoryPath, mode: "recorded" }),
      });
      expect(createRes.status).toBe(200);
      const created = (await createRes.json()) as { runId: string };
      expect(created.runId).toBeTruthy();

      const stepRes = await fetch(`http://127.0.0.1:${server.port}/api/replay/v1/runs.step`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ runId: created.runId }),
      });
      expect(stepRes.status).toBe(200);
      const stepBody = (await stepRes.json()) as { done: boolean; replayedToolCalls?: unknown[] };
      expect(stepBody.done).toBe(true);
      expect(stepBody.replayedToolCalls).toHaveLength(1);

      const stateRes = await fetch(
        `http://127.0.0.1:${server.port}/api/replay/v1/runs.getState?runId=${encodeURIComponent(created.runId)}`,
        {
          headers: { Authorization: "Bearer test-token" },
        },
      );
      expect(stateRes.status).toBe(200);

      const closeRes = await fetch(`http://127.0.0.1:${server.port}/api/replay/v1/runs.close`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ runId: created.runId }),
      });
      expect(closeRes.status).toBe(200);

      const stateAfterClose = await fetch(
        `http://127.0.0.1:${server.port}/api/replay/v1/runs.getState?runId=${encodeURIComponent(created.runId)}`,
        {
          headers: { Authorization: "Bearer test-token" },
        },
      );
      expect(stateAfterClose.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("returns 400 invalid_request for malformed JSON bodies", async () => {
    const port = await getDeterministicFreePortBlock({ offsets: [1] });
    const bearerToken = `replay-json-${randomUUID()}`;
    const server = await startReplayControlServer({
      enabled: true,
      port,
      token: bearerToken,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/replay/v1/runs.create`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          "Content-Type": "application/json",
        },
        body: "{",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("invalid_request");
    } finally {
      await server.close();
    }
  });
});
