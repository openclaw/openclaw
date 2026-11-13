import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { onSettled, Show } from "solid-js";
import { intersectOperatorScopes } from "../../../../src/shared/operator-scope-compat.js";
import { registerProfileEnglish } from "../../i18n/locales/en-profile.ts";
import { currentDisplayRuntimeConfig } from "../../lib/config/config-state-model.ts";
import { formatList } from "../../lib/format.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useApplication, useOptionalApplication } from "../../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { sharedRuntimeConfigProjection } from "../../lib/reactive/shared-application-projections.ts";

registerEnglishCatalog(registerProfileEnglish);

/** Read-only preview of the applied role policy; admission remains the Gateway's decision. */
export function PersonalRolePreview(props: { ceiling?: readonly string[] }) {
  const context = useOptionalApplication();
  return (
    <Show
      when={context}
      fallback={<p class="muted">{t("profilePage.enrollment.roleUnavailable")}</p>}
    >
      <DefaultRolePolicy ceiling={props.ceiling} />
    </Show>
  );
}
function DefaultRolePolicy(props: { ceiling?: readonly string[] }) {
  const context = useApplication();
  const gateway = projectGateway(context.gateway);
  const config = sharedRuntimeConfigProjection(context.runtimeConfig);
  const authorized = () =>
    canCallGatewayMethod(gateway.read().snapshot, "config.get", "operator.admin", {
      requireAdvertisement: false,
    });
  onSettled(() => {
    if (authorized()) {
      void context.runtimeConfig.ensureDisplayLoaded().catch(() => undefined);
    }
  });
  const policy = () => {
    if (!authorized()) {
      return null;
    }
    const state = config.read().state;
    const runtime = currentDisplayRuntimeConfig(state);
    // Only the owner's full applied snapshot can certify an absent role policy.
    if (!runtime || runtime !== state.configSnapshot?.runtimeConfig) {
      return null;
    }
    const gatewayConfig = asOptionalRecord(runtime.gateway);
    if (runtime.gateway !== undefined && !gatewayConfig) {
      return null;
    }
    if (!gatewayConfig || gatewayConfig.roles === undefined) {
      return { role: null };
    }
    const roles = asOptionalRecord(gatewayConfig.roles);
    if (roles && roles.default === undefined) {
      return { role: null };
    }
    const role = typeof roles?.default === "string" ? roles.default : undefined;
    const definition = role
      ? asOptionalRecord(asOptionalRecord(roles?.definitions)?.[role])
      : undefined;
    const scopes = definition?.scopes;
    return role &&
      Array.isArray(scopes) &&
      scopes.every((scope): scope is string => typeof scope === "string")
      ? { role, scopes }
      : null;
  };
  const configured = () => {
    const current = policy();
    return current && current.role !== null ? current : undefined;
  };
  const previewScopes = (ceiling: readonly string[]) => {
    const current = configured();
    return current ? intersectOperatorScopes(current.scopes, ceiling) : [...ceiling];
  };
  return (
    <div class="personal-role-preview" role="status">
      <Show
        when={policy()}
        fallback={<p class="muted">{t("profilePage.enrollment.roleUnavailable")}</p>}
      >
        <Show when={configured()} fallback={<p>{t("profilePage.enrollment.noRolePolicy")}</p>}>
          {(current) => (
            <p>
              {t("profilePage.enrollment.defaultRole", {
                role: current().role,
                scopes: formatList(current().scopes) || t("common.none"),
              })}
            </p>
          )}
        </Show>
        <Show
          when={props.ceiling}
          fallback={
            <p class="muted">
              {t(
                configured()
                  ? "profilePage.enrollment.approvalUnavailable"
                  : "profilePage.enrollment.deviceApprovalUnavailable",
              )}
            </p>
          }
        >
          {(ceiling) => (
            <p class="muted">
              {t(
                configured()
                  ? "profilePage.enrollment.boundedRole"
                  : "profilePage.enrollment.deviceCeiling",
                { scopes: formatList(previewScopes(ceiling())) || t("common.none") },
              )}
            </p>
          )}
        </Show>
      </Show>
      <Show when={policy()?.role !== null}>
        <p class="muted">{t("profilePage.enrollment.roleAdmission")}</p>
      </Show>
    </div>
  );
}
