import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOperatorToolGatewayAuthority } from "../../gateway/server-plugin-in-process-dispatch.js";
import { createTestOperatorAuthority } from "../admitted-run-context.test-support.js";
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
  const authority = createTestOperatorAuthority({
    profileId,
    scopes: ["operator.write"],
    retain: () => {
      changeHolds(1);
      return () => changeHolds(-1);
    },
    modelPolicy: prepareOperatorModelPolicy({
      cfg,
      policy: { sourceAgent: "main" },
      manifestPlugins: [],
    }),
  });
  return {
    cfg,
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
