/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext } from "./context.ts";
import "./app-host.ts";

type ShellWorkboardBoardState = {
  runtime: { context: ApplicationContext };
  syncWorkboardBoards: (force?: boolean) => void;
  disconnectedCallback: () => void;
};

afterEach(() => {
  vi.useRealTimers();
});

describe("OpenClaw shell Workboard catalog", () => {
  it("retries a failed forced refresh even while the previous catalog is ready", async () => {
    vi.useFakeTimers();
    const client = {} as GatewayBrowserClient;
    const ensureBoards = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const shell = document.createElement(
      "openclaw-app-shell",
    ) as unknown as ShellWorkboardBoardState;
    shell.runtime = {
      context: {
        gateway: { snapshot: { client, connected: true } },
        runtimeConfig: {
          state: {
            configSnapshot: {
              config: { plugins: { entries: { workboard: { enabled: true } } } },
            },
          },
        },
        workboard: {
          boardsReady: true,
          ensureBoards,
          clearBoards: vi.fn(),
        },
      } as unknown as ApplicationContext,
    };

    shell.syncWorkboardBoards(true);
    await Promise.resolve();
    expect(ensureBoards).toHaveBeenCalledTimes(1);

    shell.syncWorkboardBoards(false);
    await Promise.resolve();
    expect(ensureBoards).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(ensureBoards).toHaveBeenCalledTimes(3);
    expect(ensureBoards).toHaveBeenLastCalledWith(client, true);
  });

  it("forces a catalog refresh when the same client reconnects", async () => {
    const client = {} as GatewayBrowserClient;
    const gatewayState = { client, connected: false };
    const ensureBoards = vi.fn().mockResolvedValue(true);
    const shell = document.createElement(
      "openclaw-app-shell",
    ) as unknown as ShellWorkboardBoardState;
    shell.runtime = {
      context: {
        gateway: { snapshot: gatewayState },
        runtimeConfig: {
          state: {
            configSnapshot: {
              config: { plugins: { entries: { workboard: { enabled: true } } } },
            },
          },
        },
        workboard: {
          boardsReady: true,
          ensureBoards,
          clearBoards: vi.fn(),
        },
      } as unknown as ApplicationContext,
    };

    shell.syncWorkboardBoards();
    gatewayState.connected = true;
    shell.syncWorkboardBoards();
    await Promise.resolve();

    expect(ensureBoards).toHaveBeenCalledOnce();
    expect(ensureBoards).toHaveBeenCalledWith(client, true);
  });

  it("does not restart catalog retries after the shell disconnects", async () => {
    vi.useFakeTimers();
    let resolveBoards!: (loaded: boolean) => void;
    const ensureBoards = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveBoards = resolve;
        }),
    );
    const client = {} as GatewayBrowserClient;
    const shell = document.createElement(
      "openclaw-app-shell",
    ) as unknown as ShellWorkboardBoardState;
    shell.runtime = {
      context: {
        gateway: { snapshot: { client, connected: true } },
        runtimeConfig: {
          state: {
            configSnapshot: {
              config: { plugins: { entries: { workboard: { enabled: true } } } },
            },
          },
        },
        workboard: {
          boardsReady: false,
          ensureBoards,
          clearBoards: vi.fn(),
        },
      } as unknown as ApplicationContext,
    };

    shell.syncWorkboardBoards(true);
    shell.disconnectedCallback();
    resolveBoards(false);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(ensureBoards).toHaveBeenCalledOnce();
  });
});
