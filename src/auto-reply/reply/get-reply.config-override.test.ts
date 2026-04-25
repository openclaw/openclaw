import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  buildGetReplyCtx,
  createGetReplySessionState,
  expectResolvedTelegramTimezone,
  registerGetReplyRuntimeOverrides,
} from "./get-reply.test-fixtures.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";
import "./get-reply.test-runtime-mocks.js";

const mocks = vi.hoisted(() => ({
  resolveReplyDirectives: vi.fn(),
  initSessionState: vi.fn(),
}));
registerGetReplyRuntimeOverrides(mocks);

let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;
let loadConfigMock: typeof import("../../config/config.js").loadConfig;
let tryEnsureRuntimePluginsLoadedMock: typeof import("../../agents/runtime-plugins.js").tryEnsureRuntimePluginsLoaded;

async function loadGetReplyRuntimeForTest() {
  ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
  ({ loadConfig: loadConfigMock } = await import("../../config/config.js"));
  ({ tryEnsureRuntimePluginsLoaded: tryEnsureRuntimePluginsLoadedMock } = await import(
    "../../agents/runtime-plugins.js"
  ));
}

describe("getReplyFromConfig configOverride", () => {
  beforeEach(async () => {
    await loadGetReplyRuntimeForTest();
    vi.stubEnv("OPENCLAW_ALLOW_SLOW_REPLY_TESTS", "1");
    mocks.resolveReplyDirectives.mockReset();
    mocks.initSessionState.mockReset();
    vi.mocked(loadConfigMock).mockReset();
    vi.mocked(tryEnsureRuntimePluginsLoadedMock).mockClear();

    vi.mocked(loadConfigMock).mockReturnValue({});
    mocks.resolveReplyDirectives.mockResolvedValue({ kind: "reply", reply: { text: "ok" } });
    mocks.initSessionState.mockResolvedValue(createGetReplySessionState());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("merges configOverride over fresh loadConfig()", async () => {
    vi.mocked(loadConfigMock).mockReturnValue({
      channels: {
        telegram: {
          botToken: "resolved-telegram-token",
        },
      },
      agents: {
        defaults: {
          userTimezone: "UTC",
        },
      },
    } satisfies OpenClawConfig);

    await getReplyFromConfig(buildGetReplyCtx(), undefined, {
      agents: {
        defaults: {
          userTimezone: "America/New_York",
        },
      },
    } as OpenClawConfig);

    expectResolvedTelegramTimezone(mocks.resolveReplyDirectives);
  });

  it("activates runtime plugins before directive handling", async () => {
    const cfg = {
      agents: {
        defaults: {
          userTimezone: "America/New_York",
        },
      },
    } as OpenClawConfig;
    mocks.resolveReplyDirectives.mockImplementation(async () => {
      expect(tryEnsureRuntimePluginsLoadedMock).toHaveBeenCalledWith({
        config: expect.objectContaining({
          agents: cfg.agents,
        }),
        workspaceDir: "/tmp/workspace",
      });
      return { kind: "reply", reply: { text: "ok" } };
    });

    await getReplyFromConfig(buildGetReplyCtx(), undefined, cfg);
  });

  it("activates runtime plugins from spawned session workspace before directive handling", async () => {
    const cfg = {
      agents: {
        defaults: {
          userTimezone: "America/New_York",
        },
      },
    } as OpenClawConfig;
    mocks.initSessionState.mockResolvedValue(
      createGetReplySessionState({
        sessionEntry: {
          spawnedWorkspaceDir: "/tmp/spawned-workspace",
        },
      }),
    );
    mocks.resolveReplyDirectives.mockImplementation(async () => {
      expect(tryEnsureRuntimePluginsLoadedMock).toHaveBeenLastCalledWith({
        config: expect.objectContaining({
          agents: cfg.agents,
        }),
        workspaceDir: "/tmp/spawned-workspace",
      });
      return { kind: "reply", reply: { text: "ok" } };
    });

    await getReplyFromConfig(buildGetReplyCtx(), undefined, cfg);
  });
});
