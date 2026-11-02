import { createMemo, For } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsSelect } from "../../components/solid/settings-select.tsx";
import {
  SettingsSection,
  SettingsRow,
  SettingsStatus,
  SettingsToggle,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { registerDevicesEnglish } from "../../i18n/locales/en-devices.ts";
import { clampText, formatRelativeTimestamp } from "../../lib/format.ts";
import {
  isNativeExecApprovalsSnapshot,
  type ExecApprovalsFile,
  type ExecApprovalsResolvedDefaults,
  type ExecAsk,
  type ExecSecurity,
  type NativeExecApprovalsSnapshot,
} from "../../lib/nodes/page-operations.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import {
  DeviceDisclosure,
  MetaLine,
  PolicyActionRow,
  PolicyFailure,
  resolveConfigAgents,
  resolveNodeTargets,
} from "./view-shared.tsx";
import type { DevicesProps } from "./view.types.ts";

registerEnglishCatalog(registerDevicesEnglish);

type ExecApprovalsAgentOption = {
  id: string;
  name?: string;
  isDefault?: boolean;
};

type ExecApprovalsState = ReturnType<typeof resolveExecApprovalsState>;

const GATEWAY_HOST = "__gateway__";
const USE_DEFAULT = "__default__";

const SECURITY_OPTIONS: Array<{ value: ExecSecurity; labelKey: string }> = [
  { value: "deny", labelKey: "devices.execApprovals.options.deny" },
  { value: "allowlist", labelKey: "devices.execApprovals.options.allowlist" },
  { value: "full", labelKey: "devices.execApprovals.options.full" },
];

const ASK_OPTIONS: Array<{ value: ExecAsk; labelKey: string }> = [
  { value: "off", labelKey: "devices.execApprovals.options.off" },
  { value: "on-miss", labelKey: "devices.execApprovals.options.onMiss" },
  { value: "always", labelKey: "devices.execApprovals.options.always" },
];

const POLICY_FIELDS = [
  { key: "security", values: SECURITY_OPTIONS },
  { key: "ask", hintKey: "devices.execApprovals.promptPolicy", values: ASK_OPTIONS },
  {
    key: "askFallback",
    hintKey: "devices.execApprovals.promptUnavailable",
    values: SECURITY_OPTIONS,
  },
] as const;

type PolicyField = (typeof POLICY_FIELDS)[number];

function normalizeSecurity(value?: string): ExecSecurity {
  return SECURITY_OPTIONS.find((option) => option.value === value)?.value ?? "deny";
}

function resolveExecApprovalsDefaults(
  form: ExecApprovalsFile | null,
  reported: ExecApprovalsResolvedDefaults | undefined,
  includeWildcard: boolean,
): ExecApprovalsResolvedDefaults {
  const defaults = form?.defaults ?? {};
  const wildcard = includeWildcard ? (form?.agents?.["*"] ?? {}) : {};
  const ask = wildcard.ask ?? defaults.ask ?? reported?.ask;
  return {
    security: normalizeSecurity(wildcard.security ?? defaults.security ?? reported?.security),
    ask: ASK_OPTIONS.find((option) => option.value === ask)?.value ?? "on-miss",
    askFallback: normalizeSecurity(
      wildcard.askFallback ?? defaults.askFallback ?? reported?.askFallback ?? "deny",
    ),
    autoAllowSkills:
      wildcard.autoAllowSkills ?? defaults.autoAllowSkills ?? reported?.autoAllowSkills ?? false,
  };
}

function resolveExecApprovalsAgents(
  config: Record<string, unknown> | null,
  form: ExecApprovalsFile | null,
): ExecApprovalsAgentOption[] {
  const merged = new Map<string, ExecApprovalsAgentOption>(
    resolveConfigAgents(config).map((agent) => [agent.id, agent]),
  );
  for (const id of Object.keys(form?.agents ?? {})) {
    if (!merged.has(id)) {
      merged.set(id, { id });
    }
  }
  const agents = Array.from(merged.values());
  if (agents.length === 0) {
    agents.push({ id: "main", isDefault: true });
  }
  agents.sort((a, b) => {
    const aLabel = a.name?.trim() ? a.name : a.id;
    const bLabel = b.name?.trim() ? b.name : b.id;
    return (
      Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)) || aLabel.localeCompare(bLabel)
    );
  });
  return agents;
}

export function resolveExecApprovalsState(input: DevicesProps) {
  const snapshot = input.execApprovalsSnapshot;
  const nativePolicy = isNativeExecApprovalsSnapshot(snapshot) ? snapshot : null;
  const fileSnapshot = snapshot && !isNativeExecApprovalsSnapshot(snapshot) ? snapshot : null;
  const form = nativePolicy ? null : (input.execApprovalsForm ?? fileSnapshot?.file ?? null);
  const targetNodes = resolveNodeTargets(input.nodes, [
    "system.execApprovals.get",
    "system.execApprovals.set",
  ]);
  const target = input.execApprovalsTarget;
  let targetNodeId =
    target === "node" && input.execApprovalsTargetNodeId ? input.execApprovalsTargetNodeId : null;
  if (target === "node" && targetNodeId && !targetNodes.some((node) => node.id === targetNodeId)) {
    targetNodeId = null;
  }
  return {
    ready: Boolean(form),
    disabled:
      !input.connected ||
      !input.canAdmin ||
      input.execApprovalsSaving ||
      input.execApprovalsLoading,
    dirty: input.execApprovalsDirty,
    error: input.execApprovalsError,
    savedNotice: input.execApprovalsSavedNotice,
    loading: input.execApprovalsLoading,
    saving: input.execApprovalsSaving,
    nativePolicy,
    form,
    reported: fileSnapshot?.resolvedDefaults,
    agents: resolveExecApprovalsAgents(input.configForm, form),
    target,
    targetNodeId,
    targetNodes,
    onSelectTarget: input.onExecApprovalsTargetChange,
    onPatch: input.onExecApprovalsPatch,
    onRemove: input.onExecApprovalsRemove,
    onLoad: input.onLoadExecApprovals,
    onSave: input.onSaveExecApprovals,
    canAdmin: input.canAdmin,
    connected: input.connected,
  };
}

/** A host holds one policy: defaults plus each agent's overrides, read and edited in place. */
export function ExecApprovals(props: ExecApprovalsState) {
  const targetReady = () => props.target !== "node" || Boolean(props.targetNodeId);
  const reloadFailed = () => props.ready && !props.dirty && !props.saving && Boolean(props.error);
  return (
    <>
      {props.canAdmin ? (
        <SettingsSection
          title={t("devices.execApprovals.title")}
          description={
            <>
              {t("devices.execApprovals.subtitlePrefix")}{" "}
              <span class="mono">exec host=gateway/node</span>.
            </>
          }
        >
          <HostRow {...props} />
          {props.nativePolicy ? (
            <NativeExecApprovals snapshot={props.nativePolicy} />
          ) : props.ready ? (
            <PolicyScopes {...props} />
          ) : props.error ? (
            <LoadFailure {...props} />
          ) : props.loading ? (
            <PolicyActionRow description={t("common.loading")} />
          ) : targetReady() ? (
            <PolicyActionRow description={t("devices.execApprovals.loadHint")}>
              <button class="btn" disabled={!props.connected} onClick={() => props.onLoad()}>
                {t("common.loadApprovals")}
              </button>
            </PolicyActionRow>
          ) : undefined}
          {reloadFailed() ? <LoadFailure {...props} /> : undefined}
          {props.nativePolicy ? undefined : <SaveRow {...props} targetReady={targetReady()} />}
        </SettingsSection>
      ) : undefined}
    </>
  );
}

function LoadFailure(props: ExecApprovalsState) {
  return (
    <PolicyFailure
      title={t("devices.execApprovals.loadFailed")}
      message={props.error ?? ""}
      busy={props.loading}
      onRetry={props.onLoad}
    />
  );
}

function NativeExecApprovals(props: { snapshot: NativeExecApprovalsSnapshot }) {
  const rules = createMemo(() => (props.snapshot.enabled ? props.snapshot.rules : []));
  return (
    <>
      <SettingsRow
        title={t("devices.execApprovals.hostNativePolicy")}
        description={t("devices.execApprovals.hostNativeHint")}
      />
      <SettingsRow
        title={t("devices.execApprovals.defaultAction")}
        description={props.snapshot.enabled ? undefined : (props.snapshot.message ?? "unavailable")}
        control={
          props.snapshot.enabled ? (
            <SettingsValue value={props.snapshot.defaultAction} />
          ) : undefined
        }
      />
      <For each={rules()}>
        {(rule) => (
          <SettingsRow
            title={<span class="mono">{rule.pattern}</span>}
            description={
              <>
                <MetaLine
                  plain
                  parts={[
                    rule.action,
                    rule.shells?.join(", ") || t("devices.execApprovals.allShells"),
                    t(
                      rule.enabled === false
                        ? "devices.execApprovals.options.off"
                        : "devices.execApprovals.options.on",
                    ),
                  ]}
                />
                {rule.description ? clampText(rule.description, 120) : undefined}
              </>
            }
          />
        )}
      </For>
    </>
  );
}

/** Gateway and each node are one choice: the host whose policy this is. */
function HostRow(props: ExecApprovalsState) {
  const value = createMemo(() =>
    props.target === "node" ? (props.targetNodeId ?? "") : GATEWAY_HOST,
  );
  const canChoose = () => props.targetNodes.length > 0 || props.target === "node";
  return (
    <SettingsRow
      title={t("devices.execApprovals.host")}
      description={props.targetNodes.length > 0 ? undefined : t("devices.execApprovals.noNodes")}
      control={
        canChoose() ? (
          <SettingsSelect
            aria-label={t("devices.execApprovals.host")}
            value={value()}
            disabled={props.disabled}
            onChange={(event) => {
              const select = event.currentTarget;
              const next = select.value;
              if (next === GATEWAY_HOST) {
                props.onSelectTarget("gateway", null);
              } else if (next) {
                props.onSelectTarget("node", next);
              }
              // The owner may keep the host while it asks about a draft.
              select.value = value();
            }}
            options={[
              { value: GATEWAY_HOST, label: t("devices.execApprovals.gateway") },
              ...(value()
                ? []
                : [{ value: "", label: t("devices.execApprovals.selectNode"), disabled: true }]),
              ...props.targetNodes.map((node) => ({ value: node.id, label: node.label })),
            ]}
          />
        ) : (
          <SettingsValue value={t("devices.execApprovals.gateway")} />
        )
      }
    />
  );
}

function optionLabel(field: PolicyField, value: string): string {
  const option = field.values.find((candidate) => candidate.value === value);
  return option ? t(option.labelKey) : value;
}

function toggleLabel(value: boolean): string {
  return t(value ? "devices.execApprovals.options.on" : "devices.execApprovals.options.off");
}

function fieldSummary(title: string, value: string): string {
  return t("devices.execApprovals.fieldValue", { field: title, value });
}

function fieldTitle(field: PolicyField): string {
  return t(`devices.execApprovals.${field.key}`);
}

function agentName(agent: ExecApprovalsAgentOption): string {
  return agent.name?.trim() ? `${agent.name} (${agent.id})` : agent.id;
}

function PolicyScopes(props: ExecApprovalsState) {
  const fileDefaults = createMemo(() =>
    resolveExecApprovalsDefaults(props.form, props.reported, false),
  );
  const inherited = createMemo(() =>
    resolveExecApprovalsDefaults(props.form, props.reported, true),
  );
  return (
    <>
      <DeviceDisclosure
        name={t("devices.execApprovals.defaults")}
        meta={POLICY_FIELDS.slice(0, 2).map((field) =>
          fieldSummary(fieldTitle(field), optionLabel(field, fileDefaults()[field.key])),
        )}
      >
        <div class="device-policy__fields">
          <For each={POLICY_FIELDS}>
            {(field) => <DefaultsField state={props} field={field} values={fileDefaults()} />}
          </For>
          <AutoAllowField state={props} basePath={["defaults"]} effective={fileDefaults()} />
        </div>
      </DeviceDisclosure>
      <For each={props.agents} keyed={(agent) => agent.id}>
        {(agent) => <AgentPolicy state={props} agent={agent()} inherited={inherited()} />}
      </For>
    </>
  );
}

function DefaultsField(props: {
  state: ExecApprovalsState;
  field: PolicyField;
  values: ExecApprovalsResolvedDefaults;
}) {
  return (
    <SettingsRow
      title={fieldTitle(props.field)}
      description={"hintKey" in props.field ? t(props.field.hintKey) : undefined}
      control={
        <SettingsSelect
          aria-label={fieldTitle(props.field)}
          value={props.values[props.field.key]}
          disabled={props.state.disabled}
          onChange={(event) =>
            props.state.onPatch(["defaults", props.field.key], event.currentTarget.value)
          }
          options={props.field.values.map((option) => ({
            value: option.value,
            label: t(option.labelKey),
          }))}
        />
      }
    />
  );
}

/** An agent reads as what it changes from the defaults, so a plain row means nothing does. */
function agentSummary(
  agent: ExecApprovalsAgentOption,
  stored: NonNullable<ExecApprovalsFile["agents"]>[string] | undefined,
): string[] {
  const changes = POLICY_FIELDS.flatMap((field) => {
    const value = stored?.[field.key];
    return typeof value === "string"
      ? [fieldSummary(fieldTitle(field), optionLabel(field, value))]
      : [];
  });
  if (typeof stored?.autoAllowSkills === "boolean") {
    changes.push(
      fieldSummary(t("devices.execApprovals.autoAllowSkills"), toggleLabel(stored.autoAllowSkills)),
    );
  }
  const patterns = stored?.allowlist?.length ?? 0;
  if (patterns > 0) {
    changes.push(
      patterns === 1
        ? t("devices.execApprovals.onePattern")
        : t("devices.execApprovals.patterns", { count: String(patterns) }),
    );
  }
  return [
    ...(agent.isDefault ? [t("devices.binding.defaultAgent")] : []),
    ...(changes.length > 0 ? changes : [t("devices.execApprovals.usesDefaults")]),
  ];
}

function AgentPolicy(props: {
  state: ExecApprovalsState;
  agent: ExecApprovalsAgentOption;
  inherited: ExecApprovalsResolvedDefaults;
}) {
  const stored = createMemo(() => props.state.form?.agents?.[props.agent.id]);
  const basePath = () => ["agents", props.agent.id];
  return (
    <DeviceDisclosure name={agentName(props.agent)} meta={agentSummary(props.agent, stored())}>
      <div class="device-policy__fields">
        <For each={POLICY_FIELDS}>
          {(field) => {
            const override = () => {
              const value = stored()?.[field.key];
              return typeof value === "string" ? value : undefined;
            };
            const defaultLabel = () => optionLabel(field, props.inherited[field.key]);
            const hint = () => ("hintKey" in field ? t(field.hintKey) : undefined);
            return (
              <SettingsRow
                title={fieldTitle(field)}
                description={
                  override() === undefined
                    ? hint()
                    : [hint(), t("devices.execApprovals.defaultValue", { value: defaultLabel() })]
                        .filter(Boolean)
                        .join(" ")
                }
                control={
                  <SettingsSelect
                    aria-label={fieldTitle(field)}
                    value={override() ?? USE_DEFAULT}
                    disabled={props.state.disabled}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      if (value === USE_DEFAULT) {
                        props.state.onRemove([...basePath(), field.key]);
                      } else {
                        props.state.onPatch([...basePath(), field.key], value);
                      }
                    }}
                    options={[
                      {
                        value: USE_DEFAULT,
                        label: t("devices.execApprovals.useDefaultValue", {
                          value: defaultLabel(),
                        }),
                      },
                      ...field.values.map((option) => ({
                        value: option.value,
                        label: t(option.labelKey),
                      })),
                    ]}
                  />
                }
              />
            );
          }}
        </For>
        <AutoAllowField
          state={props.state}
          basePath={basePath()}
          override={stored()?.autoAllowSkills}
          effective={props.inherited}
        />
      </div>
      <Allowlist state={props.state} agentId={props.agent.id} entries={stored()?.allowlist ?? []} />
    </DeviceDisclosure>
  );
}

function AutoAllowField(props: {
  state: ExecApprovalsState;
  basePath: string[];
  override?: boolean;
  effective: ExecApprovalsResolvedDefaults;
}) {
  const overridden = () => typeof props.override === "boolean";
  return (
    <SettingsRow
      title={t("devices.execApprovals.autoAllowSkills")}
      description={
        overridden()
          ? `${t("devices.execApprovals.autoAllowSkillsHint")} ${t(
              "devices.execApprovals.defaultValue",
              { value: toggleLabel(props.effective.autoAllowSkills) },
            )}`
          : t("devices.execApprovals.autoAllowSkillsHint")
      }
      control={
        <>
          {overridden() ? (
            <button
              class="btn btn--sm"
              disabled={props.state.disabled}
              onClick={() => props.state.onRemove([...props.basePath, "autoAllowSkills"])}
            >
              {t("devices.execApprovals.useDefault")}
            </button>
          ) : undefined}
          <SettingsToggle
            checked={props.override ?? props.effective.autoAllowSkills}
            disabled={props.state.disabled}
            ariaLabel={t("devices.execApprovals.autoAllowSkills")}
            onChange={(checked) =>
              props.state.onPatch([...props.basePath, "autoAllowSkills"], checked)
            }
          />
        </>
      }
    />
  );
}

type AllowlistEntry = NonNullable<
  NonNullable<NonNullable<ExecApprovalsFile["agents"]>[string]["allowlist"]>
>[number];

function allowlistEntryMeta(entry: AllowlistEntry): string[] {
  return [
    ...(entry.lastUsedAt
      ? [t("devices.execApprovals.lastUsed", { time: formatRelativeTimestamp(entry.lastUsedAt) })]
      : []),
    ...(entry.lastUsedCommand ? [clampText(entry.lastUsedCommand, 120)] : []),
    ...(entry.lastResolvedPath ? [clampText(entry.lastResolvedPath, 120)] : []),
  ];
}

/** The pattern is the row: edit it where it reads, with its last use right under it. */
function Allowlist(props: {
  state: ExecApprovalsState;
  agentId: string;
  entries: readonly AllowlistEntry[];
}) {
  // Rows only ever join at the end, so the newest ref is the field Add pattern just made.
  let newestField: HTMLTextAreaElement | undefined;
  const path = () => ["agents", props.agentId, "allowlist"];
  return (
    <div class="device-allowlist">
      <div class="settings-row__text">
        <span class="settings-row__title">{t("devices.execApprovals.allowlist")}</span>
        <span class="settings-row__desc">{t("devices.execApprovals.allowlistHint")}</span>
      </div>
      <For each={props.entries} keyed={false}>
        {(entry, index) => (
          <div class="device-allowlist__entry">
            <div class="device-allowlist__line">
              {/* A long path has to read whole on a phone, so the field wraps instead of scrolling. */}
              <textarea
                ref={(element) => (newestField = element)}
                class="settings-input device-allowlist__input"
                rows={1}
                spellcheck="false"
                autocapitalize="off"
                aria-label={t("devices.execApprovals.pattern")}
                placeholder={t("devices.execApprovals.newPattern")}
                value={entry().pattern ?? ""}
                disabled={props.state.disabled}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                  }
                }}
                onInput={(event) =>
                  props.state.onPatch(
                    [...path(), index, "pattern"],
                    event.currentTarget.value.replace(/[\r\n]+/gu, ""),
                  )
                }
              />
              <button
                class="btn btn--icon btn--ghost"
                type="button"
                aria-label={t("devices.execApprovals.remove")}
                title={t("devices.execApprovals.remove")}
                disabled={props.state.disabled}
                onClick={() =>
                  props.state.onRemove(props.entries.length <= 1 ? path() : [...path(), index])
                }
              >
                <Icon name="x" />
              </button>
            </div>
            <MetaLine parts={allowlistEntryMeta(entry())} />
          </div>
        )}
      </For>
      <div>
        <button
          class="btn btn--sm"
          type="button"
          disabled={props.state.disabled}
          onClick={() => {
            props.state.onPatch(path(), [...props.entries, { pattern: "" }]);
            requestAnimationFrame(() => newestField?.focus());
          }}
        >
          {t("devices.execApprovals.addPattern")}
        </button>
      </div>
    </div>
  );
}

/** Only a draft needs saving, so the action comes with it and stays in reach while editing. */
function SaveRow(props: ExecApprovalsState & { targetReady: boolean }) {
  const saved = () => props.savedNotice && !props.dirty && !props.saving && !props.error;
  return (
    <>
      {props.dirty || props.saving || saved() ? (
        <PolicyActionRow
          class="device-policy__save"
          title={
            saved() ? (
              <SettingsStatus kind="ok" label={t("devices.execApprovals.saved")} />
            ) : (
              t("common.unsavedChanges")
            )
          }
          description={
            props.error ? (
              <span role="alert">
                <SettingsStatus kind="danger" label={props.error} />
              </span>
            ) : undefined
          }
        >
          <button
            class="btn primary"
            disabled={props.disabled || !props.dirty || !props.targetReady}
            onClick={() => props.onSave()}
          >
            {props.saving ? t("common.saving") : t("common.save")}
          </button>
        </PolicyActionRow>
      ) : undefined}
    </>
  );
}
