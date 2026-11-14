import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeEnv } from "../../test-utils/plugin-runtime-env.js";
import { pluginInstanceInvocation } from "../plugin-instance-invocation.js";
import { pluginInvocationContext, type PluginInvocationContext } from "../plugin-instance-scope.js";
import { createOwnedTestInstance } from "../plugin-instance.test-support.js";
import { createRuntimeAgent } from "./runtime-agent.js";
import type { PluginRuntime } from "./types.js";

type RunIngress = PluginRuntime["agent"]["runCommandFromIngress"];
type RequesterFinal = NonNullable<Parameters<RunIngress>[0]["requesterFinal"]>;

const command = vi.hoisted(() => ({
  requesterFinal: undefined as RequesterFinal | undefined,
  run: vi.fn(async (options: { requesterFinal?: RequesterFinal }) => {
    command.requesterFinal = options.requesterFinal;
    return { payloads: [] };
  }),
}));

vi.mock("../../agents/agent-command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-command.js")>()),
  agentCommandFromGatewayIngress: command.run,
}));

vi.mock("../../agents/agent-command-execution-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-command-execution-identity.js")>()),
  sanitizePublicAgentCommandIngressOpts: (options: unknown) => options,
}));

describe("runtime agent requester final", () => {
  beforeEach(() => {
    command.requesterFinal = undefined;
    command.run.mockClear();
  });

  it("re-enters the callback owner after the producer invocation closes", async () => {
    const instance = createOwnedTestInstance("discord");
    const append = vi.fn(() => true);
    const onPromoted = vi.fn();
    let staleInvocation: NonNullable<ReturnType<typeof pluginInstanceInvocation.getStore>>;
    const { log, error, exit } = createRuntimeEnv();

    await instance.run(async () => {
      staleInvocation = pluginInstanceInvocation.getStore()!;
      await createRuntimeAgent().runCommandFromIngress(
        {
          agentId: "main",
          sessionKey: "agent:main:discord:channel:requester-final-proof",
          message: "Run the delegated final probe.",
          messageChannel: "discord",
          senderIsOwner: true,
          allowModelOverride: false,
          requesterFinal: instance.wrap({ append, onPromoted }),
        },
        { log, error, exit },
      );
    });
    expect(command.run).toHaveBeenCalledOnce();
    expect(command.requesterFinal).toBeDefined();

    const closedInvocationContext = {
      lookup: () => ({
        run: () => {
          throw new Error("Plugin invocation scope is closed");
        },
        wrap: <T>(value: T) => value,
      }),
    } satisfies PluginInvocationContext;

    expect(
      pluginInstanceInvocation.run(staleInvocation!, () =>
        pluginInvocationContext.run(closedInvocationContext, () =>
          command.requesterFinal!.append("delegated final proof complete"),
        ),
      ),
    ).toBe(true);
    expect(append).toHaveBeenCalledExactlyOnceWith("delegated final proof complete");
    pluginInstanceInvocation.run(staleInvocation!, () =>
      pluginInvocationContext.run(closedInvocationContext, () =>
        command.requesterFinal!.onPromoted?.(),
      ),
    );
    expect(onPromoted).toHaveBeenCalledOnce();
  });

  it("preserves an unowned callback outside plugin scope", async () => {
    const requesterFinal = { append: vi.fn(() => true) };
    const { log, error, exit } = createRuntimeEnv();

    await createRuntimeAgent().runCommandFromIngress(
      {
        agentId: "main",
        sessionKey: "agent:main:discord:channel:requester-final-unowned",
        message: "Run the unowned requester final probe.",
        messageChannel: "discord",
        senderIsOwner: true,
        allowModelOverride: false,
        requesterFinal,
      },
      { log, error, exit },
    );

    expect(command.requesterFinal).toBe(requesterFinal);
    expect(command.requesterFinal!.append("unowned final")).toBe(true);
    expect(requesterFinal.append).toHaveBeenCalledExactlyOnceWith("unowned final");
  });
});
