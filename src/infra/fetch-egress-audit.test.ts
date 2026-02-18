import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { wrapFetchWithEgressAudit } from "./fetch-egress-audit.js";
import { resolveFetch } from "./fetch.js";

const ORIGINAL_AUDIT_FLAG = process.env.OPENCLAW_HTTP_EGRESS_AUDIT;
const ORIGINAL_AUDIT_DIR = process.env.OPENCLAW_HTTP_EGRESS_AUDIT_DIR;

async function countJsonlLines(filePath: string): Promise<number> {
  const raw = await readFile(filePath, "utf8").catch(() => "");
  const text = raw.trim();
  if (!text) {
    return 0;
  }
  return text.split("\n").length;
}

async function waitForJsonlLines(filePath: string, atLeast: number): Promise<number> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const lines = await countJsonlLines(filePath);
    if (lines >= atLeast) {
      return lines;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return countJsonlLines(filePath);
}

afterEach(() => {
  if (ORIGINAL_AUDIT_FLAG === undefined) {
    delete process.env.OPENCLAW_HTTP_EGRESS_AUDIT;
  } else {
    process.env.OPENCLAW_HTTP_EGRESS_AUDIT = ORIGINAL_AUDIT_FLAG;
  }

  if (ORIGINAL_AUDIT_DIR === undefined) {
    delete process.env.OPENCLAW_HTTP_EGRESS_AUDIT_DIR;
  } else {
    process.env.OPENCLAW_HTTP_EGRESS_AUDIT_DIR = ORIGINAL_AUDIT_DIR;
  }
});

describe("fetch egress audit", () => {
  it("does not throw when audit is enabled without OPENCLAW_HTTP_EGRESS_AUDIT_DIR", async () => {
    process.env.OPENCLAW_HTTP_EGRESS_AUDIT = "1";
    delete process.env.OPENCLAW_HTTP_EGRESS_AUDIT_DIR;

    const wrapped = wrapFetchWithEgressAudit(
      (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
    );

    const response = await wrapped("https://example.com/ok");
    expect(response.status).toBe(200);
  });

  it("returns immediately for streaming responses while audit write continues in background", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-egress-audit-"));
    process.env.OPENCLAW_HTTP_EGRESS_AUDIT = "1";
    process.env.OPENCLAW_HTTP_EGRESS_AUDIT_DIR = dir;

    try {
      const wrapped = wrapFetchWithEgressAudit((async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("hello"));
            setTimeout(() => {
              controller.enqueue(new TextEncoder().encode(" world"));
              controller.close();
            }, 800);
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/plain" } });
      }) as unknown as typeof fetch);

      const startedAt = Date.now();
      const response = await wrapped("https://example.com/stream");
      const elapsedMs = Date.now() - startedAt;

      expect(elapsedMs).toBeLessThan(250);
      await expect(response.text()).resolves.toBe("hello world");

      const date = new Date().toISOString().slice(0, 10);
      const reqFile = path.join(dir, "example.com", `${date}-requests.jsonl`);
      const resFile = path.join(dir, "example.com", `${date}-responses.jsonl`);
      expect(await waitForJsonlLines(reqFile, 1)).toBe(1);
      expect(await waitForJsonlLines(resFile, 1)).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not double-log when resolveFetch receives an already-audited fetch", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-egress-audit-"));
    process.env.OPENCLAW_HTTP_EGRESS_AUDIT = "1";
    process.env.OPENCLAW_HTTP_EGRESS_AUDIT_DIR = dir;

    try {
      const onceWrapped = wrapFetchWithEgressAudit(
        (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
      );
      const resolved = resolveFetch(onceWrapped);
      if (!resolved) {
        throw new Error("resolveFetch returned undefined");
      }
      await resolved("https://example.com/once");

      const date = new Date().toISOString().slice(0, 10);
      const reqFile = path.join(dir, "example.com", `${date}-requests.jsonl`);
      const resFile = path.join(dir, "example.com", `${date}-responses.jsonl`);
      await waitForJsonlLines(reqFile, 1);
      await waitForJsonlLines(resFile, 1);
      expect(await countJsonlLines(reqFile)).toBe(1);
      expect(await countJsonlLines(resFile)).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
