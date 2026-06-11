import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  getTailnetHostname: vi.fn(),
}));

vi.mock("../infra/tailscale.js", () => ({
  getTailnetHostname: mocks.getTailnetHostname,
}));

import { maybeSeedControlUiAllowedOriginsAtStartup } from "./startup-control-ui-origins.js";

describe("maybeSeedControlUiAllowedOriginsAtStartup", () => {
  beforeEach(() => {
    mocks.getTailnetHostname.mockReset();
  });

  it("applies origins seeded from runtime bind and port without persisting config", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };

    const result = await maybeSeedControlUiAllowedOriginsAtStartup({
      config: { gateway: {} },
      log,
      runtimeBind: "lan",
      runtimePort: 3000,
    });

    const expectedOrigins = ["http://localhost:3000", "http://127.0.0.1:3000"];
    expect(result.seededAllowedOrigins).toBe(true);
    expect(result.config.gateway?.controlUi?.allowedOrigins).toEqual(expectedOrigins);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("for bind=lan"));
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("does not rewrite config when origins already exist", async () => {
    const config: OpenClawConfig = {
      gateway: {
        controlUi: { allowedOrigins: ["https://control.example.com"] },
      },
    };
    const log = { info: vi.fn(), warn: vi.fn() };

    const result = await maybeSeedControlUiAllowedOriginsAtStartup({
      config,
      log,
      runtimeBind: "lan",
      runtimePort: 3000,
    });

    expect(result).toEqual({ config, seededAllowedOrigins: false });
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("adds active Tailscale origin for serve mode runtime", async () => {
    mocks.getTailnetHostname.mockResolvedValue("mac-studio-userspace.tailnet.ts.net");
    const log = { info: vi.fn(), warn: vi.fn() };

    const result = await maybeSeedControlUiAllowedOriginsAtStartup({
      config: {
        gateway: {
          tailscale: {
            mode: "serve",
            binaryPath: "/opt/homebrew/bin/tailscale",
            socketPath: "/tmp/tailscaled.sock",
          },
        },
      },
      log,
    });

    expect(result.seededAllowedOrigins).toBe(true);
    expect(mocks.getTailnetHostname).toHaveBeenCalledWith(undefined, {
      binaryPath: "/opt/homebrew/bin/tailscale",
      socketPath: "/tmp/tailscaled.sock",
    });
    expect(result.config.gateway?.controlUi?.allowedOrigins).toEqual([
      "https://mac-studio-userspace.tailnet.ts.net",
    ]);
  });
});
