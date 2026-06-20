import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  clearInternalHooks,
  createInternalHookEvent,
  triggerInternalHook,
} from "../../hooks/internal-hooks.js";

vi.mock("../../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: vi.fn(() => "main"),
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: vi.fn(() => ({ session: { store: "memory" } })),
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveStorePath: vi.fn(() => "store"),
}));

vi.mock("../../config/sessions/store-load.js", () => ({
  readSessionEntry: vi.fn(
    () =>
      ({
        echoTargets: [
          {
            channel: "discord",
            to: "999",
            echoUser: true,
            addedAt: 1700000000000,
          },
        ],
      }) as SessionEntry,
  ),
}));

vi.mock("./echo.js", () => ({
  fireEchoDeliveries: vi.fn(),
}));

import { registerEchoHook } from "./echo-hook.js";
import { fireEchoDeliveries as _mockFireEcho } from "./echo.js";

const mockFireEcho = vi.mocked(_mockFireEcho);

describe("registerEchoHook", () => {
  beforeEach(() => {
    clearInternalHooks();
    mockFireEcho.mockReset();
    registerEchoHook();
  });

  it("skips received user echo when chat.send already emitted the accepted-turn echo", async () => {
    await triggerInternalHook(
      createInternalHookEvent("message", "received", "agent:main:main", {
        from: "web",
        content: "hello",
        channelId: "webchat",
        conversationId: "main",
        echoUserAlreadyDelivered: true,
      }),
    );

    expect(mockFireEcho).not.toHaveBeenCalled();
  });
});
