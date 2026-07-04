// Tests get-reply config override handling for a single inbound turn.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../../config/config.js";
import { getRuntimeConfigSourcePair } from "../../config/runtime-snapshot.js";
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
let loadConfigMock: typeof import("../../config/config.js").getRuntimeConfig;

async function loadGetReplyRuntimeForTest() {
  ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
  ({ getRuntimeConfig: loadConfigMock } = await import("../../config/config.js"));
}

describe("getReplyFromConfig configOverride", () => {
  beforeEach(async () => {
    await loadGetReplyRuntimeForTest();
    vi.stubEnv("OPENCLAW_ALLOW_SLOW_REPLY_TESTS", "1");
    mocks.resolveReplyDirectives.mockReset();
    mocks.initSessionState.mockReset();
    vi.mocked(loadConfigMock).mockReset();

    vi.mocked(loadConfigMock).mockReturnValue({});
    mocks.resolveReplyDirectives.mockResolvedValue({ kind: "reply", reply: { text: "ok" } });
    mocks.initSessionState.mockResolvedValue(createGetReplySessionState());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetConfigRuntimeState();
  });

  it("merges configOverride over fresh getRuntimeConfig()", async () => {
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

  it("uses complete configOverride without reloading config", async () => {
    const { withFullRuntimeReplyConfig } = await import("./get-reply-fast-path.js");
    vi.mocked(loadConfigMock).mockImplementation(() => {
      throw new Error("getRuntimeConfig should not be called for complete runtime config");
    });

    await getReplyFromConfig(
      buildGetReplyCtx(),
      undefined,
      withFullRuntimeReplyConfig({
        channels: {
          telegram: {
            botToken: "resolved-telegram-token",
          },
        },
        agents: {
          defaults: {
            userTimezone: "America/New_York",
          },
        },
      } satisfies OpenClawConfig),
    );

    expect(loadConfigMock).not.toHaveBeenCalled();
    expectResolvedTelegramTimezone(mocks.resolveReplyDirectives);
  });

  it("preserves a paired full runtime override without reconstructing it", async () => {
    const secretRef = { source: "env", provider: "default", id: "REPLY_BROKER_TOKEN" } as const;
    const sourceConfig = {
      plugins: { entries: { brokered: { config: { service: { token: secretRef } } } } },
    } as OpenClawConfig;
    const runtimeConfig = {
      plugins: {
        entries: { brokered: { config: { service: { token: "resolved-reply-credential" } } } },
      },
    } as OpenClawConfig;
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    vi.mocked(loadConfigMock).mockReturnValue(runtimeConfig);

    await getReplyFromConfig(buildGetReplyCtx(), undefined, runtimeConfig);

    const call = mocks.resolveReplyDirectives.mock.calls[0]?.[0] as
      | { cfg?: OpenClawConfig }
      | undefined;
    expect(call?.cfg).toBe(runtimeConfig);
    expect(getRuntimeConfigSourcePair(call!.cfg!)).toBe(sourceConfig);
  });

  it("preserves provenance when merging a partial reply override", async () => {
    const secretRef = { source: "env", provider: "default", id: "REPLY_BROKER_TOKEN" } as const;
    const sourceConfig = {
      agents: { defaults: { userTimezone: "UTC" } },
      plugins: { entries: { brokered: { config: { service: { token: secretRef } } } } },
    } as OpenClawConfig;
    const runtimeConfig = structuredClone(sourceConfig);
    const runtimePluginConfig = runtimeConfig.plugins?.entries?.brokered?.config as {
      service: { token: unknown };
    };
    runtimePluginConfig.service.token = "resolved-reply-credential";
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    vi.mocked(loadConfigMock).mockReturnValue(runtimeConfig);

    await getReplyFromConfig(buildGetReplyCtx(), undefined, {
      agents: { defaults: { userTimezone: "America/New_York" } },
    });

    const call = mocks.resolveReplyDirectives.mock.calls[0]?.[0] as
      | { cfg?: OpenClawConfig }
      | undefined;
    const pairedSource = getRuntimeConfigSourcePair(call!.cfg!);
    expect(pairedSource?.agents?.defaults?.userTimezone).toBe("America/New_York");
    expect(
      (
        pairedSource?.plugins?.entries?.brokered?.config as {
          service?: { token?: unknown };
        }
      ).service?.token,
    ).toEqual(secretRef);
  });
});
