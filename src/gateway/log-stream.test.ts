import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { getLogger, resetLogger, setLoggerOverride } from "../logging.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
} from "./test-helpers.server.js";

installGatewayTestHooks();

const cleanupDirs: string[] = [];

afterEach(async () => {
  resetLogger();
  setLoggerOverride(null);
  await Promise.all(
    cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function createLogFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-log-stream-"));
  cleanupDirs.push(dir);
  return path.join(dir, "openclaw.log");
}

describe("gateway log streaming", () => {
  test("advertises log stream methods and events in hello-ok", async () => {
    const file = await createLogFile();
    setLoggerOverride({ level: "info", consoleLevel: "silent", file });

    const harness = await createGatewaySuiteHarness();
    try {
      const ws = await harness.openWs();
      try {
        const hello = await connectOk(ws, { scopes: ["operator.read"] });
        const features = (hello as { features?: { methods?: string[]; events?: string[] } })
          .features;
        expect(features?.methods).toEqual(
          expect.arrayContaining(["logs.subscribe", "logs.unsubscribe"]),
        );
        expect(features?.events).toEqual(expect.arrayContaining(["logs.appended"]));
      } finally {
        ws.close();
      }
    } finally {
      await harness.close();
    }
  });

  test("returns the initial tail and then pushes live appended log events", async () => {
    const file = await createLogFile();
    await fs.writeFile(file, '{"time":"2026-01-01T00:00:00.000Z","0":"backlog line"}\n', "utf8");
    setLoggerOverride({ level: "info", consoleLevel: "silent", file });

    const harness = await createGatewaySuiteHarness();
    try {
      const ws = await harness.openWs();
      try {
        await connectOk(ws, { scopes: ["operator.read"] });
        const subscribeRes = await rpcReq<{
          subscribed?: boolean;
          lines?: string[];
        }>(ws, "logs.subscribe", {
          limit: 200,
          maxBytes: 250_000,
        });
        expect(subscribeRes.ok).toBe(true);
        expect(subscribeRes.payload?.subscribed).toBe(true);
        expect(subscribeRes.payload?.lines).toContain(
          '{"time":"2026-01-01T00:00:00.000Z","0":"backlog line"}',
        );

        const eventPromise = onceMessage<{
          type?: string;
          event?: string;
          payload?: { lines?: string[] };
        }>(ws, (message) => message.type === "event" && message.event === "logs.appended", 10_000);

        getLogger().info("streamed log line");

        const event = await eventPromise;
        expect(event.payload?.lines?.some((line) => line.includes("streamed log line"))).toBe(true);
      } finally {
        ws.close();
      }
    } finally {
      await harness.close();
    }
  });

  test("stops delivering live log events after logs.unsubscribe", async () => {
    const file = await createLogFile();
    setLoggerOverride({ level: "info", consoleLevel: "silent", file });

    const harness = await createGatewaySuiteHarness();
    try {
      const ws = await harness.openWs();
      try {
        await connectOk(ws, { scopes: ["operator.read"] });
        const subscribeRes = await rpcReq<{ subscribed?: boolean }>(ws, "logs.subscribe");
        expect(subscribeRes.ok).toBe(true);
        expect(subscribeRes.payload?.subscribed).toBe(true);

        const unsubscribeRes = await rpcReq<{ subscribed?: boolean }>(ws, "logs.unsubscribe");
        expect(unsubscribeRes.ok).toBe(true);
        expect(unsubscribeRes.payload?.subscribed).toBe(false);

        getLogger().info("should not arrive");

        await expect(
          onceMessage(
            ws,
            (message) => message.type === "event" && message.event === "logs.appended",
            300,
          ),
        ).rejects.toThrow("timeout");
      } finally {
        ws.close();
      }
    } finally {
      await harness.close();
    }
  });
});
