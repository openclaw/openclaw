import { randomUUID } from "node:crypto";
import { note } from "../../packages/terminal-core/src/note.js";
import type { DoctorMaintenancePending } from "../commands/doctor-maintenance-pending.js";
import { copyConfigResolutionFactsThroughRewrite } from "../config/resolution-facts.js";
import { scrubDoctorErrorMessage } from "./doctor-error-message.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";
import { recordDoctorHealthWarnings } from "./doctor-health-contribution.js";

/**
 * What `runGatewayAuthHealth` would change: regenerate a redacted secret-store token,
 * configure a generated token (or ask to), or nothing. Shared by the run and its check.
 */
async function planGatewayAuthRepair(ctx: DoctorHealthFlowContext) {
  if (!ctx.sourceConfigValid) {
    return undefined;
  }
  const { detectGatewayAuthHealth } = await import("./doctor-gateway-auth.js");
  const [finding] = await detectGatewayAuthHealth({
    cfg: ctx.cfg,
    env: ctx.env,
    allowExecSecretRefs: ctx.options.allowExec,
  });
  const { resolveSecretInputRef } = await import("../config/types.secrets.js");
  const gatewayTokenRef = resolveSecretInputRef({
    value: ctx.cfg.gateway?.auth?.token,
    defaults: ctx.cfg.secrets?.defaults,
  }).ref;
  let action: "regenerate-store-token" | "configure-token" | "confirm-configure-token" | undefined;
  if (finding?.path === "gateway.auth.token") {
    if (gatewayTokenRef) {
      action =
        gatewayTokenRef.source === "store" &&
        finding.requirement === "SECRET_REF_REDACTED_VALUE" &&
        (ctx.options.generateGatewayToken === true ||
          ctx.options.repair === true ||
          ctx.options.yes === true)
          ? "regenerate-store-token"
          : undefined;
    } else {
      action =
        ctx.options.generateGatewayToken === true
          ? "configure-token"
          : ctx.options.nonInteractive === true
            ? undefined
            : "confirm-configure-token";
    }
  }
  return { finding, gatewayTokenRef, action };
}

/**
 * Read-only: whether `runGatewayAuthHealth` would change the token. An exec SecretRef that
 * Doctor may run (`--allow-exec`) is not run here; a secret-store token is read live.
 */
export async function checkGatewayAuthRepairPending(
  ctx: DoctorHealthFlowContext,
): Promise<DoctorMaintenancePending> {
  const { resolveSecretInputRef } = await import("../config/types.secrets.js");
  const source = resolveSecretInputRef({
    value: ctx.cfg.gateway?.auth?.token,
    defaults: ctx.cfg.secrets?.defaults,
  }).ref?.source;
  if (source === "exec" && ctx.options.allowExec === true) {
    return "undecidable";
  }
  const decide = async () => ((await planGatewayAuthRepair(ctx))?.action ? "work" : "none");
  if (source !== "store") {
    return decide();
  }
  const [{ decideDoctorPendingFromLiveStores }, { resolveOpenClawStateSqlitePath }] =
    await Promise.all([
      import("../commands/doctor-live-store-pending.js"),
      import("../state/openclaw-state-db.paths.js"),
    ]);
  return decideDoctorPendingFromLiveStores(
    [resolveOpenClawStateSqlitePath(ctx.env ?? process.env)],
    decide,
  );
}

export async function runGatewayAuthHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const plan = await planGatewayAuthRepair(ctx);
  if (!plan) {
    return;
  }
  const { finding, gatewayTokenRef, action } = plan;
  if (!finding) {
    if (gatewayTokenRef && ctx.options.generateGatewayToken === true) {
      note(
        `Gateway token generation skipped because gateway.auth.token is managed by SecretRef ${gatewayTokenRef.source}:${gatewayTokenRef.provider}:${gatewayTokenRef.id}. The referenced credential was left unchanged.`,
        "Gateway auth",
      );
    }
    return;
  }
  note([finding.message, finding.fixHint].filter(Boolean).join("\n"), "Gateway auth");
  if (finding.path !== "gateway.auth.token") {
    recordDoctorHealthWarnings(ctx, [finding]);
    return;
  }
  if (gatewayTokenRef) {
    if (action === "regenerate-store-token") {
      const { isRedactedSecretValue } = await import("../config/redact-sentinel.js");
      const { readSecretStoreValue, writeSecretStoreEntry } =
        await import("../secrets/store/secret-store.js");
      const { createVerifiedSqliteSnapshot } = await import("../infra/sqlite-snapshot.js");
      const { resolveOpenClawStateSqlitePath } =
        await import("../state/openclaw-state-db.paths.js");
      const { randomToken } = await import("../commands/onboard-helpers.js");
      const database = { env: ctx.env ?? process.env };
      const entry = { scope: { kind: "team" as const }, name: gatewayTokenRef.id, database };
      try {
        const current = await readSecretStoreValue(entry);
        if (!current.ok || !isRedactedSecretValue(current.value)) {
          note(
            `Secret store entry "${entry.name}" changed; rerun Doctor to inspect it.`,
            "Gateway auth",
          );
          return;
        }
        const databasePath = resolveOpenClawStateSqlitePath(database.env);
        const backup = await createVerifiedSqliteSnapshot({
          sourcePath: databasePath,
          targetPath: `${databasePath}.doctor-gateway-token.${randomUUID()}.bak`,
          preserveRowIds: true,
        });
        const nextToken = randomToken();
        await writeSecretStoreEntry({
          ...entry,
          value: nextToken,
          expectedValue: current.value,
          kind: "secret",
          updatedBy: "doctor",
        });
        note(
          `Regenerated Gateway token in secret store entry "${entry.name}"; gateway.auth.token remains a SecretRef. Backup: ${backup.path}\nRestart the Gateway, then reconnect or re-pair devices with the new token.`,
          "Gateway auth",
        );
      } catch (error) {
        const warning = `Could not repair Gateway token in secret store entry "${entry.name}": ${scrubDoctorErrorMessage(error)}. Rerun \`openclaw doctor --fix\` after resolving the reported problem.`;
        note(warning, "Gateway auth");
        recordDoctorHealthWarnings(ctx, [], [warning]);
      }
      return;
    }
    note(
      `${ctx.options.generateGatewayToken === true ? "Gateway token generation skipped because a SecretRef is configured. " : ""}Doctor will not overwrite gateway.auth.token with a plaintext value.`,
      "Gateway auth",
    );
    return;
  }
  const shouldSetToken =
    action === "configure-token" ||
    (action === "confirm-configure-token" &&
      (await ctx.prompter.confirmAutoFix({
        message: "Generate and configure a gateway token now?",
        initialValue: true,
      })));
  if (!shouldSetToken) {
    return;
  }
  const { randomToken } = await import("../commands/onboard-helpers.js");
  const nextToken = randomToken();
  const config: typeof ctx.cfg = {
    ...ctx.cfg,
    gateway: {
      ...ctx.cfg.gateway,
      auth: {
        ...ctx.cfg.gateway?.auth,
        mode: "token",
        token: nextToken,
      },
    },
  };
  copyConfigResolutionFactsThroughRewrite(ctx.cfg, config);
  ctx.cfg = config;
  note("Gateway token configured.", "Gateway auth");
}
