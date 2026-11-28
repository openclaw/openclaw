import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { resolveStateDir } from "../config/paths.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { observeHeldGatewayWorkDrain } from "./server-held-work.test-support.js";
import { createRequestGate } from "./server-methods.request-gate.test-support.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  onceMessage,
} from "./test-helpers.server.js";

installGatewayTestHooks({ scope: "suite" });

it("joins coalesced post-connect health before concurrent closes restore fixture selectors", async ({
  signal,
}) => {
  const { collectGatewayHealthSnapshot } = await import("./health/collector.js");
  const collect = vi.mocked(collectGatewayHealthSnapshot);
  const originalCollect = expectDefined(collect.getMockImplementation(), "health collector mock");
  const collectionGate = createRequestGate();
  const initialRoot = path.join(os.tmpdir(), "gateway-health-lifetime", "fixture");
  const selection = { OPENCLAW_STATE_DIR: initialRoot };
  const selectedRoots: string[] = [];
  const collections: ReturnType<typeof collect>[] = [];
  let healthSignal: AbortSignal | undefined;
  const expectHeldWork = await observeHeldGatewayWorkDrain(() => healthSignal);
  collect.mockClear();
  collect.mockImplementation((params) => {
    healthSignal = getAsyncWorkSignal();
    const collection = collectionGate.pause().then(() => {
      selectedRoots.push(resolveStateDir(selection));
      return originalCollect(params);
    });
    collections.push(collection);
    return collection;
  });
  let gateway: Awaited<ReturnType<typeof createGatewaySuiteHarness>> | undefined;
  const clients: WebSocket[] = [];
  const closing: Promise<void>[] = [];
  const unblock = () => collectionGate.release();
  signal.addEventListener("abort", unblock, { once: true });
  try {
    gateway = await createGatewaySuiteHarness({
      serverOptions: { bind: "loopback", auth: { mode: "none" } },
    });
    for (let index = 0; index < 2; index++) {
      const ws = await gateway.openWs();
      clients.push(ws);
      await connectOk(ws, { scopes: ["operator.read"] });
    }
    await collectionGate.entered;
    expect(collect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ probe: false }));

    const first = expectDefined(clients[0], "first health client");
    const disconnected = once(first, "close");
    first.close();
    await disconnected;
    expect(healthSignal?.aborted).toBe(false);
    expect(selectedRoots).toEqual([]);

    const second = expectDefined(clients[1], "second health client");
    const shutdown = onceMessage(
      second,
      (frame) => frame.type === "event" && frame.event === "shutdown",
    );
    for (let index = 0; index < 2; index++) {
      closing.push(
        gateway.server.close({ reason: "health lifetime proof" }).then(() => {
          selection.OPENCLAW_STATE_DIR = path.join(initialRoot, "restored");
          unblock();
        }),
      );
    }
    expect(await shutdown).toMatchObject({ payload: { reason: "health lifetime proof" } });
    await expectHeldWork(Promise.all(closing));
    unblock();
    await Promise.all([...closing, ...collections]);
    expect(selectedRoots).toEqual([initialRoot]);
  } finally {
    unblock();
    // Join the original producer even when the baseline public close returns early.
    await Promise.allSettled(collections);
    for (const ws of clients) {
      ws.terminate();
    }
    await Promise.all(closing.length ? closing : gateway ? [gateway.server.close()] : []);
    collect.mockImplementation(originalCollect);
    signal.removeEventListener("abort", unblock);
  }
});
