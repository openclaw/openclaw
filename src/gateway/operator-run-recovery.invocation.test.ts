import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
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
