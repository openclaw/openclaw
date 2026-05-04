/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { realtimeTalkCtor, startMock, stopMock } = vi.hoisted(() => ({
  realtimeTalkCtor: vi.fn(),
  startMock: vi.fn(),
  stopMock: vi.fn(),
}));

describe("OpenClawApp Talk controls", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("./chat/realtime-talk.ts", () => ({
      RealtimeTalkSession: realtimeTalkCtor,
    }));
    realtimeTalkCtor.mockReset();
    startMock.mockReset();
    stopMock.mockReset();
    realtimeTalkCtor.mockImplementation(
      function MockRealtimeTalkSession(this: { start: typeof startMock; stop: typeof stopMock }) {
        this.start = startMock;
        this.stop = stopMock;
      },
    );
    startMock.mockResolvedValue(undefined);
  });

  it("retries Talk immediately when the previous session is already in error state", async () => {
    const { OpenClawApp } = await import("./app.ts");
    const staleStop = vi.fn();
    const app: {
      client: unknown;
      connected: boolean;
      lastError: string | null;
      realtimeTalkActive: boolean;
      realtimeTalkStatus: string;
      realtimeTalkSession: { stop(): void } | null;
      sessionKey: string;
    } = {
      client: { request: vi.fn() },
      connected: true,
      lastError: null,
      realtimeTalkActive: true,
      realtimeTalkStatus: "error",
      realtimeTalkSession: { stop: staleStop },
      sessionKey: "main",
    };

    await OpenClawApp.prototype.toggleRealtimeTalk.call(app as never);

    expect(staleStop).toHaveBeenCalledOnce();
    expect(realtimeTalkCtor).toHaveBeenCalledOnce();
    expect(startMock).toHaveBeenCalledOnce();
    expect(stopMock).not.toHaveBeenCalled();
    expect(app.realtimeTalkStatus).toBe("connecting");
    expect(app.realtimeTalkSession).not.toBeNull();
  });
});
