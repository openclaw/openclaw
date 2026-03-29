import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as configModule from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getDeterministicFreePortBlock } from "../../test-utils/ports.js";
import { startReplayControlServer } from "./server.js";

/** Use Node `http.request` (not `fetch`) so CI proxy/env cannot inject Authorization on loopback. */
async function httpJson(params: {
  port: number;
  path: string;
  method: string;
  headers?: Record<string, string | undefined>;
  body?: string;
}): Promise<{ status: number; json: unknown }> {
  const body = params.body;
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: params.port,
        path: params.path,
        method: params.method,
        headers: {
          ...params.headers,
          ...(body !== undefined
            ? { "Content-Length": String(Buffer.byteLength(body, "utf8")) }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = raw;
          if (raw.length > 0) {
            try {
              parsed = JSON.parse(raw) as unknown;
            } catch {
              parsed = raw;
            }
          }
          resolve({ status: res.statusCode ?? 0, json: parsed });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

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
    const bearerToken = `replay-test-${randomUUID()}`;
    const server = await startReplayControlServer({
      enabled: true,
      port,
      token: bearerToken,
    });
    try {
      const unauth = await httpJson({
        port: server.port,
        path: "/api/replay/v1/runs.create",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trajectoryPath, mode: "recorded" }),
      });
      expect(unauth.status).toBe(401);

      const createRes = await httpJson({
        port: server.port,
        path: "/api/replay/v1/runs.create",
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ trajectoryPath, mode: "recorded" }),
      });
      expect(createRes.status).toBe(200);
      const created = createRes.json as { runId: string };
      expect(created.runId).toBeTruthy();

      const stepRes = await httpJson({
        port: server.port,
        path: "/api/replay/v1/runs.step",
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ runId: created.runId }),
      });
      expect(stepRes.status).toBe(200);
      const stepBody = stepRes.json as { done: boolean; replayedToolCalls?: unknown[] };
      expect(stepBody.done).toBe(true);
      expect(stepBody.replayedToolCalls).toHaveLength(1);

      const stateRes = await httpJson({
        port: server.port,
        path: `/api/replay/v1/runs.getState?runId=${encodeURIComponent(created.runId)}`,
        method: "GET",
        headers: { Authorization: `Bearer ${bearerToken}` },
      });
      expect(stateRes.status).toBe(200);

      const closeRes = await httpJson({
        port: server.port,
        path: "/api/replay/v1/runs.close",
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ runId: created.runId }),
      });
      expect(closeRes.status).toBe(200);

      const stateAfterClose = await httpJson({
        port: server.port,
        path: `/api/replay/v1/runs.getState?runId=${encodeURIComponent(created.runId)}`,
        method: "GET",
        headers: { Authorization: `Bearer ${bearerToken}` },
      });
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
      const res = await httpJson({
        port: server.port,
        path: "/api/replay/v1/runs.create",
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          "Content-Type": "application/json",
        },
        body: "{",
      });
      expect(res.status).toBe(400);
      const body = res.json as { error?: { code?: string } };
      expect(body.error?.code).toBe("invalid_request");
    } finally {
      await server.close();
    }
  });
});
