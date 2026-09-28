import {
  ErrorCodes,
  errorShape,
  validatePluginsCredentialsInspectParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { resolvePluginCredentialDescriptors } from "../../plugins/credential-descriptors.js";
import { inspectPluginCredentialValue } from "../../plugins/credential-inspection.js";
import { resolveManagedPluginMetadata } from "../../plugins/management-service.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const pluginCredentialHandlers: GatewayRequestHandlers = {
  "plugins.credentials.inspect": async ({
    params,
    client,
    context,
    respond,
    signal,
    hasCurrentClientAuthority,
  }) => {
    if (
      !assertValidParams(
        params,
        validatePluginsCredentialsInspectParams,
        "plugins.credentials.inspect",
        respond,
      )
    ) {
      return;
    }
    const authorized = () =>
      Boolean(
        client &&
        !client.invalidated &&
        !client.connectionSignal?.aborted &&
        client.connect.scopes?.includes("operator.admin") &&
        !signal?.aborted &&
        (!hasCurrentClientAuthority || hasCurrentClientAuthority()),
      );
    const denied = () =>
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Current administrator access is required to inspect plugin credentials.",
        ),
      );
    if (!authorized()) {
      denied();
      return;
    }
    try {
      const snapshot = await readConfigFileSnapshot();
      // Both references and revealed literals are private authoring data. Recheck
      // the admitted connection after I/O, before reading the unredacted snapshot.
      if (!authorized()) {
        denied();
        return;
      }
      const baseHash = snapshot.hash
        ? context.configRevisionProjector.projectRawHash(snapshot.hash)
        : undefined;
      if (!baseHash || baseHash !== params.baseHash) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "Configuration changed. Reload Settings before inspecting this reference.",
          ),
        );
        return;
      }
      const metadata = resolveManagedPluginMetadata(context.getRuntimeConfig(), process.env);
      const manifest = metadata.byPluginId.get(params.pluginId);
      const descriptor =
        manifest &&
        resolvePluginCredentialDescriptors(manifest).find(
          (field) => JSON.stringify(field.path) === JSON.stringify(params.path),
        );
      if (!descriptor) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "This installed plugin does not declare that credential field.",
          ),
        );
        return;
      }
      respond(
        true,
        {
          baseHash,
          credential: inspectPluginCredentialValue(
            snapshot.sourceConfig,
            descriptor,
            process.env,
            params.reveal === true,
          ),
        },
        undefined,
      );
    } catch {
      // Config loader failures can contain authored data; keep the public error bounded.
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "Credential metadata is unavailable. Reload Settings and try again.",
        ),
      );
    }
  },
};
