import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  setOpenClawIdTunnelPrincipalLookup,
  type OpenClawIdTunnelPrincipal,
} from "../../gateway/openclaw-id/tunnel-principal.js";
import { GatewayDispatchUnavailableError } from "../../infra/restart-recovery-errors.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import type { CronStoredJob } from "../types.js";

export const memberSourceCases = [
  "removed member",
  "changed role",
  "deleted role definition",
  "unknown role",
  "lost scope",
  "changed account",
  "changed listing",
  "disabled membership lookup",
  "storage failure",
  "dispatch unavailable",
  "storage hydration failure",
  "dispatch hydration unavailable",
] as const;

export function memberSourceCase(name: (typeof memberSourceCases)[number]) {
  const principal = {
    kind: "member",
    peerKey: `iroh:${"ab".repeat(32)}`,
    accountId: "guest-account",
    role: "guest",
    authority: { clawId: "claw", rootPub: "root", listedSeq: 1 },
  } satisfies OpenClawIdTunnelPrincipal;
  const role = {
    sessions: { others: "view" as const },
    agents: "*" as const,
    scopes: ["operator.sessions.write", "operator.cron"],
    sandbox: "required" as const,
  } satisfies GatewayOperatorRoleDefinition;
  const cfg: OpenClawConfig = {
    gateway: {
      roles: {
        definitions: {
          ...(name === "deleted role definition"
            ? {}
            : { guest: { ...role, scopes: name === "lost scope" ? [] : role.scopes } }),
          viewer: { sessions: { others: "none" }, agents: [], scopes: [] },
        },
      },
    },
  };
  const profile = ensureProfileForEmail("scheduled-member@example.test");
  setUserProfileRole(
    profile.id,
    name === "changed role" ? "viewer" : name === "unknown role" ? "unknown" : "guest",
  );
  const transientError = name.startsWith("storage")
    ? new Error("membership storage I/O failed")
    : name.startsWith("dispatch")
      ? new GatewayDispatchUnavailableError("membership lookup", true)
      : undefined;
  const current =
    name === "removed member"
      ? undefined
      : name === "changed account"
        ? { ...principal, accountId: "other-account" }
        : name === "changed listing"
          ? { ...principal, authority: { ...principal.authority, listedSeq: 2 } }
          : principal;
  setOpenClawIdTunnelPrincipalLookup(
    name === "disabled membership lookup"
      ? undefined
      : () => {
          if (transientError && !name.includes("hydration")) {
            throw transientError;
          }
          return current;
        },
    async () => {
      if (transientError && name.includes("hydration")) {
        throw transientError;
      }
    },
  );
  const operatorSource: CronStoredJob["operatorSource"] = {
    executionRevision: "member-source",
    source: {
      version: 1,
      kind: "gateway",
      agentId: "main",
      sourceRunId: "source-run",
      snapshot: {
        profileId: profile.id,
        openclawIdPrincipal: principal,
        scopes: role.scopes,
        assignedRole: "guest",
        githubLogin: null,
        rolePolicy: role,
        grant: null,
        aliasBindingIds: [],
        authPolicy: {
          generation: "",
          grantGeneration: "fixture-grant",
          role: "operator",
          authMethod: "trusted-proxy",
        },
        controlUiAdmin: false,
        localOperator: false,
        sourceIngress: "control-ui",
      },
    },
  };
  return {
    cfg,
    operatorSource,
    transientError,
    refusal: ["lost scope", "changed role", "deleted role definition", "unknown role"].includes(
      name,
    )
      ? "Restart recovery operator source policy changed."
      : "OpenClaw ID membership changed. Reconnect before starting a request.",
  };
}
