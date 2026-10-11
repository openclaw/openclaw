import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { callGateway, callGatewayCli } from "./call.js";

type GatewayOptions = Parameters<typeof callGateway>[0];

describe("operator CLI message input", () => {
  const readConfig = vi.fn((): never => {
    throw new Error("configuration resolution reached");
  });
  const input = (options: GatewayOptions) => ({
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

  const session: GatewayOptions = { method: "sessions.send", scopes: ["operator.admin"] };
  const agent: GatewayOptions = { method: "agent", scopes: ["operator.admin"] };
  const taskCompletion = /task completion path/;
  const attribution = /inter-session attribution/;
  const configuration = /configuration resolution reached/;
  const cliName = {
    method: "sessions.send",
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    mode: GATEWAY_CLIENT_MODES.BACKEND,
  };
  const cliMode = {
    method: "sessions.send",
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    mode: GATEWAY_CLIENT_MODES.CLI,
  };

  it.each([
    ["subagent", callGatewayCli, session, undefined, "1", taskCompletion, 0],
    ["subagent shell", callGatewayCli, session, "exec", "1", taskCompletion, 0],
    [
      "subagent other method",
      callGatewayCli,
      { method: "agent" },
      undefined,
      "1",
      configuration,
      1,
    ],
    ["shell session", callGatewayCli, session, "exec", undefined, attribution, 0],
    ["shell agent", callGatewayCli, agent, "exec", undefined, attribution, 0],
    ["CLI name", callGateway, cliName, "exec", undefined, attribution, 0],
    ["CLI mode", callGateway, cliMode, "exec", undefined, attribution, 0],
    ["backend defaults", callGateway, { method: "agent" }, "exec", undefined, configuration, 1],
  ] as const)(
    "guards %s before configuration resolution",
    async (_label, call, options, shell, subagent, error, configReads) => {
      vi.stubEnv("OPENCLAW_SHELL", shell);
      vi.stubEnv("OPENCLAW_SUBAGENT_EXEC", subagent);
      await expect(call(input(options))).rejects.toThrow(error);
      expect(readConfig).toHaveBeenCalledTimes(configReads);
    },
  );
});
