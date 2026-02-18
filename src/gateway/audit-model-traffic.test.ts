import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditModelTrafficWrite, setAuditConfig } from "./audit-model-traffic.js";

const ORIGINAL_AUDIT_FLAG = process.env.OPENCLAW_AUDIT_MODEL_TRAFFIC;
const ORIGINAL_AUDIT_PATH = process.env.OPENCLAW_AUDIT_MODEL_TRAFFIC_PATH;

afterEach(() => {
  setAuditConfig(undefined);

  if (ORIGINAL_AUDIT_FLAG === undefined) {
    delete process.env.OPENCLAW_AUDIT_MODEL_TRAFFIC;
  } else {
    process.env.OPENCLAW_AUDIT_MODEL_TRAFFIC = ORIGINAL_AUDIT_FLAG;
  }

  if (ORIGINAL_AUDIT_PATH === undefined) {
    delete process.env.OPENCLAW_AUDIT_MODEL_TRAFFIC_PATH;
  } else {
    process.env.OPENCLAW_AUDIT_MODEL_TRAFFIC_PATH = ORIGINAL_AUDIT_PATH;
  }
});

describe("auditModelTrafficWrite", () => {
  it("suppresses outbound response payloads when granularity.response is false", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-model-traffic-"));
    const logPath = path.join(dir, "model-traffic.jsonl");

    try {
      setAuditConfig({
        enabled: true,
        path: logPath,
        granularity: {
          headers: true,
          body: true,
          response: false,
        },
      });

      auditModelTrafficWrite({
        ts: Date.now(),
        kind: "model_traffic",
        source: "test",
        direction: "in",
        id: "in-1",
        headers: { authorization: "Bearer abcdef123456" },
        body: { prompt: "hello" },
      });
      auditModelTrafficWrite({
        ts: Date.now(),
        kind: "model_traffic",
        source: "test",
        direction: "out",
        id: "out-1",
        status: 200,
        headers: { authorization: "Bearer abcdef123456" },
        body: { answer: "world" },
      });

      const lines = (await readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      const inbound = lines.find((entry) => entry.direction === "in");
      const outbound = lines.find((entry) => entry.direction === "out");

      expect(inbound).toBeDefined();
      expect(outbound).toBeDefined();
      expect(inbound?.body).toEqual({ prompt: "hello" });
      expect(outbound?.body).toBeUndefined();
      expect(outbound?.headers).toBeUndefined();
      expect(outbound?.status).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
