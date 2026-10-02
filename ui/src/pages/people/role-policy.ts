import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import {
  GATEWAY_OWNER_PROFILE_ID,
  type UserProfile,
} from "../../../../packages/gateway-protocol/src/schema/users.js";
import {
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";

const copy = (key: string) => t(`profilePage.people.${key}`);
const stringList = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string")
    ? value
    : null;
export type RoleCatalog = { defaultName: string | null; definitions: Record<string, unknown> };
export type ProfileRoleChoice =
  | { kind: "owner" }
  | { kind: "unresolved" }
  | {
      kind: "role";
      name: string;
      definition: Record<string, unknown>;
      source: "assigned" | "unassigned" | "retired";
    };

/** Presentation of the existing assignment/default contract, never connection authorization. */
export function profileRoleChoice(profile: UserProfile, catalog: RoleCatalog): ProfileRoleChoice {
  if (profile.id === GATEWAY_OWNER_PROFILE_ID) {
    return { kind: "owner" };
  }
  const assigned = profile.role;
  const assignedKnown = Boolean(assigned && Object.hasOwn(catalog.definitions, assigned));
  const name = assignedKnown ? assigned : catalog.defaultName;
  const definition =
    name && Object.hasOwn(catalog.definitions, name)
      ? asOptionalRecord(catalog.definitions[name])
      : undefined;
  return name && definition
    ? {
        kind: "role",
        name,
        definition,
        source: assignedKnown ? "assigned" : assigned ? "retired" : "unassigned",
      }
    : { kind: "unresolved" };
}

function fact(title: string, value: unknown, description?: string) {
  return renderSettingsRow({
    title,
    description,
    stackedOnNarrow: true,
    control: renderSettingsValue(value),
  });
}

export function renderConfiguredRolePolicy(
  roleName: string,
  policy: Record<string, unknown>,
  sourceDescription: string | undefined,
  ceilingDescription = copy("ceilingHint"),
) {
  const sessions = asOptionalRecord(policy.sessions);
  const model = asOptionalRecord(policy.modelPolicy);
  const agents = policy.agents === "*" ? copy("allAgents") : stringList(policy.agents);
  const scopes = stringList(policy.scopes);
  const allow = model ? stringList(model.allow) : null;
  const deny = model ? stringList(model.deny) : null;
  return renderSettingsSection(
    { title: copy("policy"), description: ceilingDescription },
    html`
      ${fact(copy("policySource"), roleName, sourceDescription)}
      ${fact(
        copy("agents"),
        typeof agents === "string"
          ? agents
          : agents === null
            ? copy("unknown")
            : agents.length
              ? agents.join(", ")
              : copy("noneAgents"),
      )}
      ${fact(
        copy("otherSessions"),
        typeof sessions?.others === "string" ? copy(`others.${sessions.others}`) : copy("unknown"),
      )}
      ${fact(copy("sandbox"), copy(policy.sandbox === "required" ? "sandboxRequired" : "sandboxInherit"))}
      ${fact(copy("models"), model ? copy("modelsRestricted") : copy("modelsInherited"))}
      <details class="settings-row settings-row--stacked">
        <summary>${copy("details")}</summary>
        ${fact(copy("scopes"), scopes === null ? copy("unknown") : scopes.length ? scopes.join(", ") : copy("noScopes"), copy("scopeHint"))}
        ${
          model
            ? html`
                ${fact(copy("modelSource"), typeof model.sourceAgent === "string" ? model.sourceAgent : copy("defaultSource"))}
                ${fact(copy("modelAllow"), allow === null ? copy("sourceModels") : allow.length ? allow.join(", ") : copy("noModels"))}
                ${fact(copy("modelDeny"), deny?.length ? deny.join(", ") : copy("none"))}
              `
            : nothing
        }
        ${fact(copy("accessPolicy"), typeof policy.accessPolicyPlugin === "string" ? policy.accessPolicyPlugin : copy("none"), copy("eligibilityHint"))}
        ${fact(copy("sandbox"), copy("sandboxHint"))}
        ${fact(copy("otherSessions"), copy("sessionHint"))}
        ${fact(copy("models"), copy("modelHint"))} ${fact(copy("roles"), copy("rolesProvenance"))}
      </details>
    `,
  );
}
