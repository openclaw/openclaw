import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createWorkboardCapability } from "./capability.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const board = (id: string) => ({
  id,
  total: 0,
  active: 0,
  archived: 0,
  byStatus: {},
});

describe("Workboard capability board catalog", () => {
  it("queues a forced refresh that arrives during the initial catalog load", async () => {
    const first = deferred<{ boards: ReturnType<typeof board>[] }>();
    const request = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ boards: [board("ops")] });
    const client = { request } as unknown as GatewayBrowserClient;
    const capability = createWorkboardCapability();

    const initialLoad = capability.ensureBoards(client);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const forcedRefresh = capability.ensureBoards(client, true);
    first.resolve({ boards: [board("default")] });

    await expect(initialLoad).resolves.toBe(true);
    await expect(forcedRefresh).resolves.toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    expect(capability.state.boards.map((entry) => entry.id)).toEqual(["ops"]);
    expect(capability.boardsReady).toBe(true);
    capability.dispose();
  });

  it("clears catalog authority when the plugin is disabled", async () => {
    const request = vi.fn().mockResolvedValue({ boards: [board("ops")] });
    const capability = createWorkboardCapability();

    await capability.ensureBoards({ request } as unknown as GatewayBrowserClient);
    capability.clearBoards();

    expect(capability.state.boards).toEqual([]);
    expect(capability.boardsReady).toBe(false);
    capability.dispose();
  });

  it("loads the replacement client after a previous client load finishes", async () => {
    const first = deferred<{ boards: ReturnType<typeof board>[] }>();
    const firstClient = { request: vi.fn(() => first.promise) } as unknown as GatewayBrowserClient;
    const secondRequest = vi.fn().mockResolvedValue({ boards: [board("ops")] });
    const secondClient = { request: secondRequest } as unknown as GatewayBrowserClient;
    const capability = createWorkboardCapability();

    const staleLoad = capability.ensureBoards(firstClient);
    const replacementLoad = capability.ensureBoards(secondClient);
    await vi.waitFor(() => expect(secondRequest).toHaveBeenCalledOnce());
    first.resolve({ boards: [board("default")] });

    await expect(staleLoad).resolves.toBe(false);
    await expect(replacementLoad).resolves.toBe(true);
    expect(capability.state.boards.map((entry) => entry.id)).toEqual(["ops"]);
    capability.dispose();
  });

  it("hides a previous client's catalog while its replacement loads", async () => {
    const replacement = deferred<{ boards: ReturnType<typeof board>[] }>();
    const firstClient = {
      request: vi.fn().mockResolvedValue({ boards: [board("first")] }),
    } as unknown as GatewayBrowserClient;
    const secondClient = {
      request: vi.fn(() => replacement.promise),
    } as unknown as GatewayBrowserClient;
    const capability = createWorkboardCapability();

    await capability.ensureBoards(firstClient);
    const replacementLoad = capability.ensureBoards(secondClient);

    expect(capability.state.boards).toEqual([]);
    expect(capability.boardsReady).toBe(false);
    replacement.resolve({ boards: [board("second")] });
    await expect(replacementLoad).resolves.toBe(true);
    expect(capability.state.boards.map((entry) => entry.id)).toEqual(["second"]);
    capability.dispose();
  });

  it("does not let an old queued caller supersede a replacement client", async () => {
    const first = deferred<{ boards: ReturnType<typeof board>[] }>();
    const replacement = deferred<{ boards: ReturnType<typeof board>[] }>();
    const firstClient = { request: vi.fn(() => first.promise) } as unknown as GatewayBrowserClient;
    const secondClient = {
      request: vi.fn(() => replacement.promise),
    } as unknown as GatewayBrowserClient;
    const capability = createWorkboardCapability();

    const staleLoad = capability.ensureBoards(firstClient);
    const staleWaiter = capability.ensureBoards(firstClient, true);
    const replacementLoad = capability.ensureBoards(secondClient);
    first.resolve({ boards: [board("stale")] });
    replacement.resolve({ boards: [board("ops")] });

    await expect(staleLoad).resolves.toBe(false);
    await expect(staleWaiter).resolves.toBe(false);
    await expect(replacementLoad).resolves.toBe(true);
    expect(capability.state.boards.map((entry) => entry.id)).toEqual(["ops"]);
    expect(capability.boardsReady).toBe(true);
    capability.dispose();
  });

  it("does not let a queued caller repopulate a cleared catalog", async () => {
    const first = deferred<{ boards: ReturnType<typeof board>[] }>();
    const request = vi.fn(() => first.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    const capability = createWorkboardCapability();

    const staleLoad = capability.ensureBoards(client);
    const staleWaiter = capability.ensureBoards(client, true);
    capability.clearBoards();
    first.resolve({ boards: [board("stale")] });

    await expect(staleLoad).resolves.toBe(false);
    await expect(staleWaiter).resolves.toBe(false);
    expect(request).toHaveBeenCalledOnce();
    expect(capability.state.boards).toEqual([]);
    expect(capability.boardsReady).toBe(false);
    capability.dispose();
  });

  it("preserves the previous catalog when a forced response is malformed", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ boards: [board("ops")] })
      .mockResolvedValueOnce({ ok: true });
    const client = { request } as unknown as GatewayBrowserClient;
    const capability = createWorkboardCapability();

    await expect(capability.ensureBoards(client)).resolves.toBe(true);
    await expect(capability.ensureBoards(client, true)).resolves.toBe(false);

    expect(capability.state.boards.map((entry) => entry.id)).toEqual(["ops"]);
    expect(capability.boardsReady).toBe(true);
    capability.dispose();
  });
});
