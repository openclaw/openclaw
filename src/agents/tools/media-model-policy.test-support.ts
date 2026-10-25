import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOperatorToolGatewayAuthority } from "../../gateway/server-plugin-in-process-dispatch.js";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import { prepareOperatorModelPolicy } from "../operator-model-policy.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";

export function createMediaModelPolicyFixture(
  kind: "image" | "pdf",
  profileId: string,
  source: "direct" | "admitted",
  changeHolds: (delta: number) => void,
) {
  const cfg: OpenClawConfig = {
    plugins: { enabled: false },
    agents: {
      entries: { main: {} },
      defaults: {
        model: "test-provider/allowed",
        models: { "test-provider/blocked": { alias: "blocked-alias" } },
        [`${kind}Model`]: {
          primary: "test-provider/blocked",
          fallbacks: ["test-provider/allowed"],
        },
      },
    },
  };
  let active = true;
  const authority = createAdmittedRunOperatorAuthority({
    profileId,
    scopes: ["operator.write"],
    retain: () => {
      changeHolds(1);
      return () => changeHolds(-1);
    },
    assertCurrent: () => {
      if (!active) {
        throw new Error("requester retired");
      }
    },
    modelPolicy: prepareOperatorModelPolicy({
      cfg,
      policy: { sourceAgent: "main" },
      manifestPlugins: [],
    }),
  });
  return {
    cfg,
    setActive(this: void, value: boolean) {
      active = value;
    },
    runWithRequester<T>(this: void, run: () => Promise<T>) {
      return source === "direct"
        ? withOperatorToolGatewayAuthority(
            { scopes: ["operator.write"], operatorRunAuthority: authority },
            run,
          )
        : withGatewayToolCallerIdentity(
            { agentId: "main", sessionKey: "agent:main:reader", operatorAuthority: authority },
            run,
          );
    },
  };
}
