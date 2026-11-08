import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
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
export function RolePolicy(props: { name: string; policy: Record<string, unknown> }) {
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
  return (
    <SettingsSection title={peopleCopy("policy")} description={peopleCopy("ceilingHint")}>
      <PolicyFact title={peopleCopy("role")} value={props.name} />
      <PolicyFact title={peopleCopy("agents")} value={agents()} />
      <PolicyFact title={peopleCopy("otherSessions")} value={others()} />
      <PolicyFact
        title={peopleCopy("sandbox")}
        value={peopleCopy(
          props.policy.sandbox === "required" ? "sandboxRequired" : "sandboxInherit",
        )}
      />
      <details class="settings-row settings-row--stacked">
        <summary>{peopleCopy("details")}</summary>
        <p class="settings-row__desc">{peopleCopy("detailsHint")}</p>
        <pre class="people-permissions__policy">{JSON.stringify(props.policy, null, 2)}</pre>
      </details>
    </SettingsSection>
  );
}
