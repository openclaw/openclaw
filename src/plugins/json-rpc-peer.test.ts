import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { JsonRpcPeer } from "./json-rpc-peer.js";

describe("JsonRpcPeer", () => {
  it("handles bidirectional requests and notifications", async () => {
    const output = new PassThrough();
    const written: string[] = [];
    output.setEncoding("utf8");
    output.on("data", (chunk) => written.push(String(chunk)));
    const peer = new JsonRpcPeer({
      write: output,
      requestTimeoutMs: 1000,
      maxPendingRequests: 4,
      requestHandlers: new Map([["host.echo", async (params) => ({ params })]]),
    });

    peer.handle({ jsonrpc: "2.0", id: "child-1", method: "host.echo", params: { value: 1 } });
    await vi.waitFor(() => expect(written.join("")).toContain('"id":"child-1"'));

    const pending = peer.request("plugin.echo", { value: 2 });
    peer.handle({ jsonrpc: "2.0", id: 1, result: { value: 2 } });
    await expect(pending).resolves.toEqual({ value: 2 });
  });

  it("sends cancellation notifications", async () => {
    const output = new PassThrough();
    let written = "";
    output.setEncoding("utf8");
    output.on("data", (chunk) => (written += String(chunk)));
    const peer = new JsonRpcPeer({
      write: output,
      requestTimeoutMs: 1000,
      maxPendingRequests: 4,
    });
    const controller = new AbortController();
    const pending = peer.request("plugin.slow", {}, { signal: controller.signal });

    controller.abort();

    await expect(pending).rejects.toThrow("aborted");
    expect(written).toContain('"method":"$/cancelRequest"');
  });

  it("enforces the pending request limit", async () => {
    const peer = new JsonRpcPeer({
      write: new PassThrough(),
      requestTimeoutMs: 1000,
      maxPendingRequests: 1,
    });
    const first = peer.request("plugin.first");

    await expect(peer.request("plugin.second")).rejects.toThrow("pending request limit");
    peer.close(new Error("done"));
    await expect(first).rejects.toThrow("done");
  });

  it("rejects duplicate and excess child requests", async () => {
    const output = new PassThrough();
    let written = "";
    output.setEncoding("utf8");
    output.on("data", (chunk) => (written += String(chunk)));
    let release: (() => void) | undefined;
    const peer = new JsonRpcPeer({
      write: output,
      requestTimeoutMs: 1000,
      maxPendingRequests: 1,
      requestHandlers: new Map([
        [
          "host.slow",
          () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
        ],
      ]),
    });

    peer.handle({ jsonrpc: "2.0", id: "active", method: "host.slow" });
    peer.handle({ jsonrpc: "2.0", id: "active", method: "host.slow" });
    peer.handle({ jsonrpc: "2.0", id: "excess", method: "host.slow" });

    await vi.waitFor(() => expect(written).toContain("Duplicate request id"));
    expect(written).toContain("incoming request limit exceeded");
    release?.();
  });

  it("drops late handler responses after close", async () => {
    const output = new PassThrough();
    let written = "";
    output.setEncoding("utf8");
    output.on("data", (chunk) => (written += String(chunk)));
    let release: (() => void) | undefined;
    const peer = new JsonRpcPeer({
      write: output,
      requestTimeoutMs: 1000,
      maxPendingRequests: 1,
      requestHandlers: new Map([
        [
          "host.slow",
          () =>
            new Promise<string>((resolve) => {
              release = () => resolve("late");
            }),
        ],
      ]),
    });

    peer.handle({ jsonrpc: "2.0", id: "late", method: "host.slow" });
    peer.close(new Error("closed"));
    release?.();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(written).toBe("");
  });

  it("times out child requests and releases the incoming slot", async () => {
    vi.useFakeTimers();
    const output = new PassThrough();
    let written = "";
    output.setEncoding("utf8");
    output.on("data", (chunk) => (written += String(chunk)));
    const peer = new JsonRpcPeer({
      write: output,
      requestTimeoutMs: 10,
      maxPendingRequests: 1,
      requestHandlers: new Map(
        ["host.slow"].map((method) => [method, () => new Promise(() => {})]),
      ),
    });

    peer.handle({ jsonrpc: "2.0", id: "slow", method: "host.slow" });
    await vi.advanceTimersByTimeAsync(10);
    peer.handle({ jsonrpc: "2.0", id: "next", method: "host.slow" });

    expect(written).toContain("request timed out");
    expect(written).not.toContain("incoming request limit exceeded");
    peer.close(new Error("done"));
    vi.useRealTimers();
  });
});
