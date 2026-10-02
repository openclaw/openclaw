import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { callGateway, callGatewayCli } from "./call.js";

describe("operator CLI message input", () => {
  const readConfig = vi.fn((): never => {
    throw new Error("configuration resolution reached");
  });
  const input = (options: Parameters<typeof callGateway>[0]) => ({
    ...options,
    get config() {
      return readConfig();
    },
  });
  beforeEach(() => {
    readConfig.mockClear();
    vi.stubEnv("OPENCLAW_SHELL", "exec");
    vi.stubEnv("OPENCLAW_SUBAGENT_EXEC", undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([undefined, "exec"])(
    "preserves the upstream subagent refusal with shell=%s",
    async (shell) => {
      vi.stubEnv("OPENCLAW_SHELL", shell);
      vi.stubEnv("OPENCLAW_SUBAGENT_EXEC", "1");
      await expect(
        callGatewayCli(
          input({
            method: "sessions.send",
            scopes: ["operator.admin"],
          }),
        ),
      ).rejects.toThrow("task completion path");
      expect(readConfig).not.toHaveBeenCalled();
    },
  );

  it("does not broaden the upstream subagent-only marker to other methods", async () => {
    vi.stubEnv("OPENCLAW_SHELL", undefined);
    vi.stubEnv("OPENCLAW_SUBAGENT_EXEC", "1");
    await expect(callGatewayCli(input({ method: "agent" }))).rejects.toThrow(
      "configuration resolution reached",
    );
    expect(readConfig).toHaveBeenCalledOnce();
  });

  it.each(["sessions.send", "agent"])(
    "refuses direct callGatewayCli %s before reading configuration or credentials",
    async (method) => {
      const options = input({ method, scopes: ["operator.admin"] });
      await expect(callGatewayCli(options)).rejects.toThrow(/inter-session attribution/);
      expect(readConfig).not.toHaveBeenCalled();
    },
  );

  it.each([
    { clientName: GATEWAY_CLIENT_NAMES.CLI, mode: GATEWAY_CLIENT_MODES.BACKEND },
    { clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT, mode: GATEWAY_CLIENT_MODES.CLI },
  ])("keeps mixed CLI identities on the guarded entry: %j", async (identity) => {
    const options = input({
      method: "sessions.send",
      ...identity,
    });
    await expect(callGateway(options)).rejects.toThrow(/inter-session attribution/);
    expect(readConfig).not.toHaveBeenCalled();
  });

  it("does not classify omitted backend defaults as operator CLI", async () => {
    await expect(callGateway(input({ method: "agent" }))).rejects.toThrow(
      "configuration resolution reached",
    );
    expect(readConfig).toHaveBeenCalledOnce();
  });
});
