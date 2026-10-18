import { isDeepStrictEqual } from "node:util";
import { readDaemonRuntimePinForInstall } from "../../daemon/runtime-pin-state.js";
import { withGatewayServiceOperationLock } from "../../daemon/service-operation-lock.js";
import { fingerprintGatewayServiceDefinition } from "../../daemon/service-rebind.js";
import {
  hasGatewayServiceDefinitionOverrides,
  resolveManagedGatewayServiceCommand,
} from "../../daemon/service-types.js";
import { resolveGatewayService } from "../../daemon/service.js";
import type { UpdateCommandOptions } from "./shared.js";
import {
  assertOriginalServiceStateCompatible,
  revalidateOriginalManagedServiceRuntime,
} from "./update-command-original-service.js";
import { withRetainedUpdateServiceAuthority } from "./update-command-retained-service.js";
import type { OriginalManagedServiceRuntime } from "./update-command-service-context-types.js";

/** Undo only our proved A->B rewrite. A/B custody, schema and final native lock remain mandatory. */
export async function restoreOriginalManagedServiceDefinition(params: {
  original: OriginalManagedServiceRuntime;
  run: NonNullable<UpdateCommandOptions["run"]>;
  assertCurrent: () => void;
  onGatewayStartAttempted?: () => void;
  stdout: NodeJS.WritableStream;
  timeoutMs?: number;
}): Promise<void> {
  const { original } = params;
  const env = { ...original.service.serviceEnv };
  await withRetainedUpdateServiceAuthority(
    { ...params, root: original.root },
    async (assertCurrent) =>
      withGatewayServiceOperationLock(env, async (assertNative) => {
        const assertOwned = () => {
          assertNative();
          assertCurrent();
        };
        await assertOriginalServiceStateCompatible(original, assertOwned);
        const state = await revalidateOriginalManagedServiceRuntime(
          original,
          assertOwned,
          params.timeoutMs,
          true,
        );
        assertOwned();
        const current = await fingerprintGatewayServiceDefinition(state.command);
        assertOwned();
        const expectedPin = readDaemonRuntimePinForInstall(
          { kind: "gateway", env },
          state.command,
          true,
        );
        assertOwned();
        if (
          current === original.definition.fingerprint &&
          expectedPin.revision === original.definition.runtimePin.revision
        ) {
          return;
        }
        if (!original.definition.rebound || current !== original.definition.rebound) {
          throw new Error("Service replacement is not this update's own rebind.");
        }
        const command = original.definition.command;
        if (hasGatewayServiceDefinitionOverrides(command) || command.reloadPending) {
          throw new Error(
            "Retained service has operator-owned definition overrides; restoration refused.",
          );
        }
        if (expectedPin.revision !== original.definition.reboundRuntimePin) {
          throw new Error("Runtime intent changed after this update rebind; restoration refused.");
        }
        const definition = resolveManagedGatewayServiceCommand(command) ?? command;
        await resolveGatewayService().install({
          env,
          stdout: params.stdout,
          preserveAutoStart: true,
          runtimePinUpdate: { expected: expectedPin, pin: original.definition.runtimePin.pin },
          assertCurrent: assertOwned,
          beforeMutation: async () => {
            await assertOriginalServiceStateCompatible(original, assertOwned);
            await revalidateOriginalManagedServiceRuntime(
              original,
              assertOwned,
              params.timeoutMs,
              true,
            );
            assertOwned();
            params.onGatewayStartAttempted?.();
          },
          programArguments: [...definition.programArguments],
          workingDirectory: definition.workingDirectory,
          environment: { ...definition.environment },
          environmentValueSources: { ...definition.environmentValueSources },
        });
        assertOwned();
        const restored = await resolveGatewayService().readCommand(env, { requireEffective: true });
        assertOwned();
        if (!isDeepStrictEqual(restored, command)) {
          throw new Error("Restored service does not match the captured original command.");
        }
        const fingerprint = await fingerprintGatewayServiceDefinition(restored);
        assertOwned();
        original.definition.fingerprint = fingerprint;
        original.definition.rebound = undefined;
        original.definition.reboundRuntimePin = undefined;
        await revalidateOriginalManagedServiceRuntime(original, assertOwned, params.timeoutMs);
      }),
  );
}
