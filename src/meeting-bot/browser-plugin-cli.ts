import { callGatewayFromCli } from "../cli/gateway-rpc.js";
import { registerMeetingPluginCli } from "./plugin-cli.js";

export function registerBrowserMeetingCli(
  options: Pick<Parameters<typeof registerMeetingPluginCli>[0], "program" | "config"> & {
    callGateway?: typeof callGatewayFromCli;
    descriptor: { name: string; description: string };
    joinDescription: string;
    meetingLabel: string;
    resolveTimeoutMs(
      config: Parameters<typeof registerMeetingPluginCli>[0]["config"],
      options: { probe: boolean; requestedTimeoutMs?: number },
    ): number;
  },
) {
  const commandName = options.descriptor.name;
  registerMeetingPluginCli({
    ...options,
    callGateway: options.callGateway ?? callGatewayFromCli,
    commandName,
    methodPrefix: commandName,
    descriptions: {
      root: options.descriptor.description,
      join: options.joinDescription,
      leave: `leave a ${options.meetingLabel}`,
      status: `show ${options.meetingLabel} session status`,
      setup: `check ${options.meetingLabel} prerequisites`,
      testSpeech: "join and verify talk-back output",
      testListen: "join in transcribe mode and report caption support",
    },
    resolveGatewayTimeoutMs: ({ config, method, requestedTimeoutMs }) =>
      options.resolveTimeoutMs(config, {
        probe: method === `${commandName}.testSpeech` || method === `${commandName}.testListen`,
        requestedTimeoutMs,
      }),
  });
}
