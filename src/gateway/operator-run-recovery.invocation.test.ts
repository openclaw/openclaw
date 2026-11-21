import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { captureAgentTurnPrincipal } from "./agent-turn/principal.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "./device-revocation.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { captureGatewayOperatorContinuation } from "./operator-run-recovery.js";
import { withRecovery } from "./operator-run-recovery.test-support.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

it.each(["invocation", "source"] as const)(
  "reauthorizes the original policy, not the original invocation (%s retired)",
  (retired) =>
    withRecovery(async (fixture) => {
      let current = true;
      const source = new AbortController();
      const original = expectDefined(
        await captureGatewayOperatorRunAuthority({
          client: fixture.client,
          context: fixture.context,
          sourceAuthority: {
            gatewayAccessGrant: null,
            signal: source.signal,
            assertCurrent: () => source.signal.throwIfAborted(),
          },
          invocationAuthority: {
            assertCurrent: () => {
              if (!current) {
                throw new Error("Original input retired");
              }
            },
          },
        }),
        "original input authority",
      );
      const client = createSyntheticPluginRuntimeClient({
        authenticatedUserProfile: fixture.client.authenticatedUserProfile,
        operatorRoleActor: { kind: "operator", profileId: original.authority.profileId },
        operatorRunAuthority: original.authority,
        scopes: ["operator.write"],
      });
      const first = expectDefined(
        await captureGatewayOperatorContinuation({ client, context: fixture.context }),
        "first continuation",
      );
      try {
        current = false;
        if (retired === "source") {
          source.abort(new Error("Original policy revoked"));
        }
        expect(original.authority.assertCurrent).toThrow();
        original.release();
        client.internal!.operatorRunAuthority = first.authority;
        const next = captureGatewayOperatorContinuation({ client, context: fixture.context });
        if (retired === "source") {
          await expect(next).rejects.toThrow("Original policy revoked");
        } else {
          const descendant = expectDefined(
            await next,
            "descendant after original input retirement",
          );
          descendant.release();
        }
      } finally {
        first.release();
        original.release();
      }
    }),
);

it.each(["allowed", "revoked"] as const)(
  "admits a retained tokenless continuation after its origin ended unless revoked (%s)",
  (change) =>
    withRecovery(
      async (fixture) => {
        const connection = new AbortController();
        Object.assign(fixture.client, { connectionSignal: connection.signal });
        const caller = captureGatewayDeviceRevocation(
          fixture.context,
          { deviceId: "recovery-device", role: "operator" },
          () => !fixture.client.invalidated,
        );
        fixture.context.invalidateClientsForDevice = (deviceId, options) => {
          invalidateGatewayDeviceRevocation(fixture.context, deviceId, options?.role);
          fixture.client.invalidated = true;
        };
        const parent = new AbortController();
        const captured = expectDefined(
          await captureGatewayOperatorRunAuthority({
            client: captureAgentTurnPrincipal(fixture.client),
            context: fixture.context,
            sourceAuthority: null,
            hasCurrentClientAuthority: caller.isCurrent,
            invocationAuthority: { assertCurrent: () => parent.signal.throwIfAborted() },
          }),
          "accepted source",
        );
        expectDefined(fixture.client.internal, "authenticated client").operatorRunAuthority =
          captured.authority;
        const continuation = expectDefined(
          await captureGatewayOperatorContinuation({
            client: fixture.client,
            context: fixture.context,
          }),
          "detached continuation",
        );
        let descendant: typeof continuation | undefined;
        let releaseRetained = expectDefined(continuation.authority.retain, "retain")();
        try {
          expect(continuation.authority.recoverySnapshot?.device).toBeUndefined();
          // The original request, its closure and its connection all end before replay.
          continuation.release();
          captured.release();
          caller.release();
          connection.abort(new Error("Original socket closed"));
          // The parent invocation is obsolete; a detached child still takes new holds.
          parent.abort(new Error("Parent chat was edited"));
          const releaseNext = expectDefined(continuation.authority.retain, "retain")();
          releaseRetained();
          releaseRetained = releaseNext;
          fixture.client.internal!.operatorRunAuthority = continuation.authority;
          descendant = expectDefined(
            await captureGatewayOperatorContinuation({
              client: fixture.client,
              context: fixture.context,
            }),
            "descendant after origin retirement",
          );
          releaseRetained();
          fixture.client.internal!.operatorRunAuthority = descendant.authority;
          const replay = expectDefined(descendant.authority.reauthorize, "replay admission");
          if (change === "allowed") {
            expect(replay).not.toThrow();
          } else {
            fixture.context.invalidateClientsForDevice?.("recovery-device", {
              role: "operator",
            });
            // Admitted work finishes; a replay starts through the same admission as new work.
            expect(descendant.authority.assertCurrent).not.toThrow();
            expect(replay).toThrow();
            await expect(
              captureGatewayOperatorContinuation({
                client: fixture.client,
                context: fixture.context,
              }),
            ).rejects.toThrow();
          }
        } finally {
          descendant?.release();
          releaseRetained();
        }
      },
      { tokenlessDevice: true },
    ),
);
