/** Applies lifecycle ownership and mutation fencing before platform service writes. */
import {
  assertGatewayServiceMutationAllowed,
  type SupervisorAction,
} from "../infra/gateway-supervision.js";
import { assertFutureConfigActionAllowed } from "./future-config-guard.js";
import { withGatewayServiceOperationLock } from "./service-operation-lock.js";
import { captureGatewayServiceRebind } from "./service-rebind.js";
import type { GatewayService, GatewayServiceEnv } from "./service-types.js";
import {
  getGatewayServiceUpdateNativeCommand,
  withGatewayServiceUpdateAuthority,
} from "./service-update-authority.js";

export function guardGatewayServiceMutation<
  TArgs extends {
    env?: GatewayServiceEnv;
    assertCurrent?: () => void;
    beforeMutation?: () => Promise<void>;
  },
  TResult,
>(
  action: string,
  supervisorAction: SupervisorAction,
  mutate: (args: TArgs) => Promise<TResult>,
  readCommand?: GatewayService["readCommand"],
  readRuntimePinRevision?: (env: GatewayServiceEnv) => string,
): (args: TArgs) => Promise<TResult> {
  return async (args) => {
    // Mutations must satisfy both lifecycle ownership and durable-config
    // version guards before invoking any platform service manager.
    assertGatewayServiceMutationAllowed(action, process.env, supervisorAction);
    if (args.env && args.env !== process.env) {
      assertGatewayServiceMutationAllowed(action, args.env, supervisorAction);
    }
    const assertCaller = args.assertCurrent;
    return await withGatewayServiceOperationLock(args.env ?? process.env, async (assertNative) => {
      await assertFutureConfigActionAllowed(action);
      return await withGatewayServiceUpdateAuthority(
        assertCaller,
        async (assertCurrent) => {
          await args.beforeMutation?.();
          assertCurrent();
          const result = readCommand
            ? await captureGatewayServiceRebind(
                () => readCommand(args.env ?? process.env, { requireEffective: true }),
                assertCurrent,
                (preserveAutoStart) =>
                  mutate({
                    ...args,
                    assertCurrent,
                    ...(preserveAutoStart ? { preserveAutoStart: true } : {}),
                  }),
                readRuntimePinRevision
                  ? () => readRuntimePinRevision(args.env ?? process.env)
                  : undefined,
              )
            : await mutate({ ...args, assertCurrent });
          assertCurrent();
          return result;
        },
        {
          updateOwned: false,
          assertRecoveryCurrent: assertNative,
          nativeCommand: getGatewayServiceUpdateNativeCommand(),
        },
      );
    });
  };
}
