/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";

describe("OpenClawApp Talk controls", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("retries Talk immediately when the previous session is already in error state", async () => {
    await import("./app.ts");
    const app = document.createElement("openclaw-app") as unknown as {
      client: unknown;
      connected: boolean;
      realtimeTalkActive: boolean;
      realtimeTalkStatus: string;
      realtimeTalkSession: { stop(): void } | null;
      sessionKey: string;
      toggleRealtimeTalk(): Promise<void>;
    };
    const staleStop = vi.fn();
    const request = vi.fn().mockRejectedValue(new Error("session unavailable"));
    app.client = { request } as never;
    app.connected = true;
    app.sessionKey = "main";
    app.realtimeTalkActive = true;
    app.realtimeTalkStatus = "error";
    app.realtimeTalkSession = { stop: staleStop };

    await app.toggleRealtimeTalk();

    expect(staleStop).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("talk.realtime.session", { sessionKey: "main" });
    expect(app.realtimeTalkStatus).toBe("error");
    expect(app.realtimeTalkSession).toBeNull();
  });
});
