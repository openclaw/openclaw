import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { Show } from "solid-js";
import {
  SettingsRow,
  SettingsSection,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { t } from "../../lib/reactive/i18n.ts";

export const peopleCopy = (key: string) => t("profilePage.people." + key);

export function PolicyFact(props: { title: string; value: string; description?: string }) {
  return (
    <SettingsRow
      title={props.title}
      description={props.description}
      stackedOnNarrow
      control={<SettingsValue value={props.value} />}
    />
  );
}

/** Presentation only: these configured maximums never authorize another person's activity. */
export function RolePolicy(props: {
  name: string;
  policy: Record<string, unknown>;
  detailsOpen?: boolean;
  onDetailsToggle?: (open: boolean) => void;
}) {
  const agents = () =>
    props.policy.agents === "*"
      ? peopleCopy("allAgents")
      : Array.isArray(props.policy.agents)
        ? props.policy.agents.join(", ") || peopleCopy("none")
        : peopleCopy("unknown");
  const others = () => {
    const value = asOptionalRecord(props.policy.sessions)?.others;
    return typeof value === "string" ? peopleCopy("others." + value) : peopleCopy("unknown");
  };
  const models = () => asOptionalRecord(props.policy.modelPolicy);
  const allowedModels = () => {
    const policy = models();
    return !policy
      ? peopleCopy("noModelRestriction")
      : Array.isArray(policy.allow)
        ? policy.allow.join(", ") || peopleCopy("noModels")
        : peopleCopy("sourceModels");
  };
  const modelSource = () => {
    const source = models()?.sourceAgent;
    return typeof source === "string" ? source : peopleCopy("defaultModelSource");
  };
  const excludedModels = () => {
    const denied = models()?.deny;
    return Array.isArray(denied)
      ? denied.join(", ") || peopleCopy("noModelExclusions")
      : peopleCopy("noModelExclusions");
  };
  return (
    <SettingsSection title={peopleCopy("policy")} description={peopleCopy("ceilingHint")}>
      <PolicyFact title={peopleCopy("configuredRole")} value={props.name} />
      <PolicyFact title={peopleCopy("agents")} value={agents()} />
      <PolicyFact title={peopleCopy("otherSessions")} value={others()} />
      <PolicyFact
        title={peopleCopy("sandbox")}
        value={peopleCopy(
          props.policy.sandbox === "required" ? "sandboxRequired" : "sandboxInherit",
        )}
      />
      <PolicyFact
        title={peopleCopy("scopeCeiling")}
        value={
          Array.isArray(props.policy.scopes)
            ? props.policy.scopes.join(", ") || peopleCopy("none")
            : peopleCopy("unknown")
        }
      />
      <Show when={models()}>
        <PolicyFact title={peopleCopy("modelSource")} value={modelSource()} />
        <PolicyFact title={peopleCopy("excludedModels")} value={excludedModels()} />
      </Show>
      <PolicyFact
        title={peopleCopy("allowedModels")}
        value={allowedModels()}
        description={peopleCopy("modelHint")}
      />
      <PolicyFact
        title={peopleCopy("accessPolicy")}
        value={
          typeof props.policy.accessPolicyPlugin === "string"
            ? props.policy.accessPolicyPlugin
            : peopleCopy("noAccessPolicy")
        }
        description={
          typeof props.policy.accessPolicyPlugin === "string"
            ? peopleCopy("accessPolicyHint")
            : undefined
        }
      />
      <details
        class="settings-row settings-row--stacked"
        open={props.detailsOpen}
        onToggle={(event) => props.onDetailsToggle?.(event.currentTarget.open)}
      >
        <summary>{peopleCopy("details")}</summary>
        <p class="settings-row__desc">{peopleCopy("detailsHint")}</p>
        <pre class="people-permissions__policy">{JSON.stringify(props.policy, null, 2)}</pre>
      </details>
    </SettingsSection>
  );
}
