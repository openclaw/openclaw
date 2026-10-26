import { expectTypeOf } from "vitest";
import type { agentCommandFromIngress } from "../../src/plugin-sdk/agent-runtime.js";
import type { PluginRuntime } from "../../src/plugin-sdk/core.js";

type PublicIngressOptions = Parameters<typeof agentCommandFromIngress>[0];
type PublicExecutionStarted = NonNullable<PublicIngressOptions["onExecutionStarted"]>;
type RuntimeIngressExecutionStarted = NonNullable<
  Parameters<PluginRuntime["agent"]["runCommandFromIngress"]>[0]["onExecutionStarted"]
>;
type RuntimeEmbeddedExecutionStarted = NonNullable<
  Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0]["onExecutionStarted"]
>;
// public agent ingress correlation contract
// keeps runId optional and private execution recovery state unavailable
const optionalRunIdCaller: PublicIngressOptions = {
  message: "hello",
  sessionKey: "agent:main:plugin-session",
  allowModelOverride: false,
};
const privateRecoveryCorrelationIsHidden: "executionIdentityAdmission" extends keyof PublicIngressOptions
  ? false
  : true = true;

void optionalRunIdCaller;
void privateRecoveryCorrelationIsHidden;

// accepts ignored synchronous and asynchronous execution-start returns
const observed: string[] = [];
const synchronous = () => observed.push("started");
const asynchronous = async () => {
  observed.push("started");
};
expectTypeOf(synchronous).toExtend<PublicExecutionStarted>();
expectTypeOf(asynchronous).toExtend<PublicExecutionStarted>();
expectTypeOf(synchronous).toExtend<RuntimeIngressExecutionStarted>();
expectTypeOf(asynchronous).toExtend<RuntimeIngressExecutionStarted>();
expectTypeOf(synchronous).toExtend<RuntimeEmbeddedExecutionStarted>();
expectTypeOf(asynchronous).toExtend<RuntimeEmbeddedExecutionStarted>();
