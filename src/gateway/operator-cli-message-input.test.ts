import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { callGateway, callGatewayCli } from "./call.js";

describe("operator CLI message input", () => {
  const readConfig = vi.fn((): never => {
    throw new Error("configuration resolution reached");
  });
  beforeEach(() => {
    readConfig.mockClear();
    vi.stubEnv("OPENCLAW_SHELL", "exec");
    vi.stubEnv("OPENCLAW_SUBAGENT_EXEC", undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(
    ["sessions.send", "sessions.steer", "chat.send"].flatMap((method) =>
      [undefined, "exec"].map((shell) => ({ method, shell })),
    ),
  )(
    "preserves the upstream subagent refusal for $method with shell=$shell",
    async ({ method, shell }) => {
      vi.stubEnv("OPENCLAW_SHELL", shell);
      vi.stubEnv("OPENCLAW_SUBAGENT_EXEC", "1");
      await expect(
        callGatewayCli({
          method,
          scopes: ["operator.admin"],
          get config() {
            return readConfig();
          },
        }),
      ).rejects.toThrow("task completion path");
      expect(readConfig).not.toHaveBeenCalled();
    },
  );

  it("does not broaden the upstream subagent-only marker to other methods", async () => {
    vi.stubEnv("OPENCLAW_SHELL", undefined);
    vi.stubEnv("OPENCLAW_SUBAGENT_EXEC", "1");
    await expect(
      callGatewayCli({
        method: "agent",
        get config() {
          return readConfig();
        },
      }),
    ).rejects.toThrow("configuration resolution reached");
    expect(readConfig).toHaveBeenCalledOnce();
  });

  it.each(["sessions.send", "sessions.steer", "chat.send", "agent"])(
    "refuses direct callGatewayCli %s before reading configuration or credentials",
    async (method) => {
      const options = {
        method,
        scopes: ["operator.admin" as const],
        get config() {
          return readConfig();
        },
      };
      await expect(callGatewayCli(options)).rejects.toThrow(/inter-session attribution/);
      expect(readConfig).not.toHaveBeenCalled();
    },
  );

  it.each([
    { clientName: GATEWAY_CLIENT_NAMES.CLI, mode: GATEWAY_CLIENT_MODES.BACKEND },
    { clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT, mode: GATEWAY_CLIENT_MODES.CLI },
  ])("keeps mixed CLI identities on the guarded entry: %j", async (identity) => {
    const options = {
      method: "sessions.send",
      ...identity,
      get config() {
        return readConfig();
      },
    };
    await expect(callGateway(options)).rejects.toThrow(/inter-session attribution/);
    expect(readConfig).not.toHaveBeenCalled();
  });

  it("does not classify omitted backend defaults as operator CLI", async () => {
    await expect(
      callGateway({
        method: "agent",
        get config() {
          return readConfig();
        },
      }),
    ).rejects.toThrow("configuration resolution reached");
    expect(readConfig).toHaveBeenCalledOnce();
  });
});
