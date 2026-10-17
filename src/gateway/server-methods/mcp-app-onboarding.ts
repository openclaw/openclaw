import { z } from "zod";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { root } from "../../infra/fs-safe.js";
import { getGatewayPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-state.js";
import { iteratePluginRootContributions } from "../../plugins/plugin-root-contributions.js";
import { dispatchGatewayMethodInProcessRaw } from "../server-plugin-in-process-dispatch.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlers } from "./types.js";

const schema = z.object({
  sessionKey: z.string().min(1),
  agentId: z.string().optional(),
  pluginId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  expectedLeafEntryId: z.string().nullable().optional(),
});
/** Installation only publishes metadata. This endpoint requires an explicit user click. */
export const mcpAppOnboardingHandlers: GatewayRequestHandlers = {
  "mcp.app.onboard": async (options) => {
    try {
      const params = schema.parse(options.params);
      const access = options.sessionAccessAuthority;
      if (!access) {
        throw new Error("Plugin onboarding session authority is unavailable");
      }
      access.assertCurrent();
      const requestAuthority = readGatewayRequestMutationAuthority(options);
      const metadata = getGatewayPluginMetadataSnapshot();
      if (!metadata) {
        throw new Error("Plugin metadata is not ready");
      }
      const find = () =>
        [
          ...iteratePluginRootContributions({
            metadataSnapshot: metadata,
            config: options.context.getRuntimeConfig(),
            contribution: "skills",
          }),
        ].find(({ record }) => record.id === params.pluginId)?.record;
      const plugin = find();
      if (!plugin?.onboardingSkill) {
        throw new Error("This plugin has no packaged onboarding skill");
      }
      const file = await (
        await root(plugin.rootDir)
      ).read(plugin.onboardingSkill, {
        maxBytes: 256 * 1024,
        hardlinks: "reject",
        symlinks: "reject",
      });
      access.assertCurrent();
      if (getGatewayPluginMetadataSnapshot() !== metadata || find() !== plugin) {
        throw new Error("Plugin onboarding availability changed");
      }
      // The user chooses this packaged skill. Its contents remain ordinary plugin
      // instructions inside a user turn; they never become host/system authority.
      const result = await dispatchGatewayMethodInProcessRaw(
        "chat.send",
        {
          sessionKey: access.target.sessionKey,
          agentId: access.target.agentId,
          message:
            "Run the setup skill for plugin " + plugin.id + ".\n\n" + file.buffer.toString("utf8"),
          idempotencyKey: params.idempotencyKey,
          ...(params.expectedLeafEntryId !== undefined
            ? { expectedLeafEntryId: params.expectedLeafEntryId }
            : {}),
          suppressCommandInterpretation: true,
        },
        {
          disableSyntheticClient: true,
          requireScopedClient: true,
          signal: options.signal,
          hasCurrentClientAuthority: options.hasCurrentClientAuthority,
          // The nested router binds chat's own session authority before this final
          // admission check. Detached chat work must not retain our invocation hold.
          prepareDispatchCurrent: async () => access.assertCurrent(),
          sessionMutationCommitGuard: requestAuthority.assertCurrent,
        },
      );
      options.respond(result.ok, result.payload, result.error);
    } catch (error) {
      options.respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  },
};
