import { describeCoreBoardDataContract } from "../boards/board-data-contracts.js";
import {
  CORE_BOARD_DATA_BINDING_IDS,
  CORE_BOARD_HOST_CAPABILITY_IDS,
} from "../boards/board-host-capability-ids.js";
import type { PluginRegistry } from "./registry-types.js";

const MAX_CONTRACT_BYTES = 32 * 1024;
const AUTHORITY_NOTICE =
  "Metadata only: this does not read data, select a user resource, grant access, or execute a capability. Runtime authorization and declared grants still apply.";

/** Pure metadata lookup. No handlers, plugin entrypoints, resource reads or grant mutations. */
export function describeDashboardCapabilityContract(
  id: string,
  registry:
    | Pick<PluginRegistry, "dashboardDataBindings" | "dashboardActionVerbs">
    | null
    | undefined,
) {
  if (!id || id.length > 256) {
    return { status: "invalid_id", authority: AUTHORITY_NOTICE };
  }
  const core = CORE_BOARD_HOST_CAPABILITY_IDS.some((candidate) => candidate === id);
  const data = registry?.dashboardDataBindings.get(id);
  const action = registry?.dashboardActionVerbs.get(id);
  if (!core && !data && !action) {
    return { id, status: "unknown_or_inactive", authority: AUTHORITY_NOTICE };
  }
  const known = core ? describeCoreBoardDataContract(id) : undefined;
  const description = core
    ? { owner: "core", ...known }
    : {
        owner: (data ?? action)!.pluginId,
        method: (data ?? action)!.method,
        description: (data ?? action)!.description,
        ...(action?.paramShape ? { inputSchema: action.paramShape } : {}),
        ...(action
          ? { requiredActionBindingParams: action.requiredActionBindingParams ?? [] }
          : {}),
      };
  const result = {
    id,
    status: known ? "documented" : "metadata_only",
    kind:
      data || CORE_BOARD_DATA_BINDING_IDS.some((candidate) => candidate === id)
        ? "read"
        : action
          ? "action"
          : "core",
    authority: AUTHORITY_NOTICE,
    ...description,
    ...(!known
      ? {
          resultCoverage: "unavailable",
          notice:
            "No maintained result contract is exposed here. Do not guess result fields or units.",
        }
      : {}),
  };
  const encoded = JSON.stringify(result);
  if (Buffer.byteLength(encoded, "utf8") > MAX_CONTRACT_BYTES) {
    return { id, status: "contract_too_large", authority: AUTHORITY_NOTICE };
  }
  // Return detached JSON data: callers cannot mutate canonical schemas or registrations.
  // SAFETY: encoded is the JSON serialization of the locally constructed result object above.
  return JSON.parse(encoded) as Record<string, unknown>;
}
