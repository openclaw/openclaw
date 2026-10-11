import { createMemo, For } from "solid-js";
import "../../components/agent-select-registration.ts";
import { icons as legacyIcons } from "../../components/icons.ts";
import {
  SettingsSection,
  SettingsRow,
  SettingsEmpty,
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
import { resolveConfigAgents, resolveNodeTargets } from "./view-shared.tsx";
import type { DevicesProps } from "./view.types.ts";

registerEnglishCatalog(registerDevicesEnglish);

type ExecApprovalsAgentOption = {
  id: string;
  name?: string;
  isDefault?: boolean;
};

type ExecApprovalsState = ReturnType<typeof resolveExecApprovalsState>;

const EXEC_APPROVALS_DEFAULT_SCOPE = "__defaults__";

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

function normalizeSecurity(value?: string): ExecSecurity {
  return SECURITY_OPTIONS.find((option) => option.value === value)?.value ?? "deny";
}

function normalizeAsk(value?: string): ExecAsk {
  return ASK_OPTIONS.find((option) => option.value === value)?.value ?? "on-miss";
}

function resolveExecApprovalsDefaults(
  form: ExecApprovalsFile | null,
  reported: ExecApprovalsResolvedDefaults | undefined,
  includeWildcard: boolean,
): ExecApprovalsResolvedDefaults {
  const defaults = form?.defaults ?? {};
  const wildcard = includeWildcard ? (form?.agents?.["*"] ?? {}) : {};
  return {
    security: normalizeSecurity(wildcard.security ?? defaults.security ?? reported?.security),
    ask: normalizeAsk(wildcard.ask ?? defaults.ask ?? reported?.ask),
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
  const ready = Boolean(form || nativePolicy);
  const agents = resolveExecApprovalsAgents(input.configForm, form);
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
  const selected = input.execApprovalsSelectedAgent;
  const selectedScope =
    selected && agents.some((agent) => agent.id === selected)
      ? selected
      : EXEC_APPROVALS_DEFAULT_SCOPE;
  const defaults = resolveExecApprovalsDefaults(
    form,
    fileSnapshot?.resolvedDefaults,
    selectedScope !== EXEC_APPROVALS_DEFAULT_SCOPE,
  );
  const selectedAgent =
    selectedScope !== EXEC_APPROVALS_DEFAULT_SCOPE ? (form?.agents?.[selectedScope] ?? null) : null;
  const allowlist = selectedAgent?.allowlist;
  return {
    ready,
    disabled: !input.canAdmin || input.execApprovalsSaving || input.execApprovalsLoading,
    dirty: input.execApprovalsDirty,
    loading: input.execApprovalsLoading,
    saving: input.execApprovalsSaving,
    nativePolicy,
    defaults,
    selectedScope,
    selectedAgent,
    agents,
    allowlist: Array.isArray(allowlist) ? allowlist : [],
    target,
    targetNodeId,
    targetNodes,
    onSelectScope: input.onExecApprovalsSelectAgent,
    onSelectTarget: input.onExecApprovalsTargetChange,
    onPatch: input.onExecApprovalsPatch,
    onRemove: input.onExecApprovalsRemove,
    onLoad: input.onLoadExecApprovals,
    onSave: input.onSaveExecApprovals,
    canAdmin: input.canAdmin,
  };
}

export function ExecApprovals(props: ExecApprovalsState) {
  const ready = createMemo(() => props.ready);
  const targetReady = createMemo(() => props.target !== "node" || Boolean(props.targetNodeId));
  const saveButton = (
    <button
      class="btn"
      disabled={props.disabled || !props.dirty || !targetReady() || Boolean(props.nativePolicy)}
      onClick={() => props.onSave()}
    >
      {props.saving ? t("common.saving") : t("common.save")}
    </button>
  );
  const rows = (
    <>
      {!props.canAdmin ? (
        <SettingsRow title={t("devices.readOnly.adminRequired")} />
      ) : (
        <>
          <ExecApprovalsTarget {...props} />
          {!ready() ? (
            <SettingsRow
              title={t("devices.execApprovals.loadHint")}
              control={
                <button
                  class="btn"
                  disabled={props.loading || !targetReady()}
                  onClick={props.onLoad}
                >
                  {props.loading ? t("common.loading") : t("common.loadApprovals")}
                </button>
              }
            />
          ) : props.nativePolicy ? (
            <NativeExecApprovals snapshot={props.nativePolicy} />
          ) : (
            <>
              <ExecApprovalsScope {...props} /> <ExecApprovalsPolicy {...props} />
            </>
          )}
        </>
      )}
    </>
  );
  return (
    <>
      <SettingsSection
        title={t("devices.execApprovals.title")}
        description={
          <>
            {t("devices.execApprovals.subtitlePrefix")}{" "}
            <span class="mono">exec host=gateway/node</span>.
          </>
        }
        actions={saveButton}
      >
        {rows}
      </SettingsSection>
      {props.canAdmin &&
      ready() &&
      !props.nativePolicy &&
      props.selectedScope !== EXEC_APPROVALS_DEFAULT_SCOPE ? (
        <ExecApprovalsAllowlist {...props} />
      ) : undefined}
    </>
  );
}

function NativeExecApprovals(props: { snapshot: NativeExecApprovalsSnapshot }) {
  const rules = createMemo(() =>
    props.snapshot.enabled && Array.isArray(props.snapshot.rules) ? props.snapshot.rules : [],
  );
  const defaultAction = createMemo(() =>
    props.snapshot.enabled
      ? props.snapshot.defaultAction
      : (props.snapshot.message ?? "unavailable"),
  );
  return (
    <>
      <SettingsRow
        title={t("devices.execApprovals.hostNativePolicy")}
        description={t("devices.execApprovals.hostNativeHint")}
        control={<SettingsValue value={t("devices.execApprovals.native")} />}
      />
      <SettingsRow
        title={t("devices.execApprovals.defaultAction")}
        description={defaultAction()}
        control={
          <SettingsValue
            value={t(
              rules().length === 1 ? "devices.execApprovals.rule" : "devices.execApprovals.rules",
              {
                count: String(rules().length),
              },
            )}
          />
        }
      />
      <For each={rules()}>
        {(rule) => (
          <SettingsRow
            title={rule.pattern}
            description={
              <>
                {rule.action} · {rule.shells?.join(", ") || t("devices.execApprovals.allShells")} ·
                {rule.enabled === false
                  ? t("devices.execApprovals.off")
                  : t("devices.execApprovals.on")}
                {rule.description ? (
                  <>
                    <br />
                    {clampText(rule.description ?? "", 120)}
                  </>
                ) : undefined}
              </>
            }
          />
        )}
      </For>
    </>
  );
}

function ExecApprovalsTarget(props: ExecApprovalsState) {
  const hasNodes = createMemo(() => props.targetNodes.length > 0);
  const nodeValue = createMemo(() => props.targetNodeId ?? "");
  return (
    <>
      <SettingsRow
        title={t("devices.execApprovals.target")}
        description={t("devices.execApprovals.targetHint")}
        control={
          <select
            class="settings-select"
            aria-label={t("devices.execApprovals.host")}
            value={props.target}
            disabled={props.disabled}
            onChange={(event) => {
              const target = event.currentTarget;
              const value = target.value;
              if (value === "node") {
                const first = props.targetNodes[0]?.id ?? null;
                props.onSelectTarget("node", nodeValue() || first);
              } else {
                props.onSelectTarget("gateway", null);
              }
              target.value = props.target;
            }}
          >
            <option value="gateway" selected={props.target === "gateway"}>
              {t("devices.execApprovals.gateway")}
            </option>
            <option value="node" selected={props.target === "node"}>
              {t("devices.execApprovals.node")}
            </option>
          </select>
        }
      />
      {props.target === "node" ? (
        <SettingsRow
          title={t("devices.execApprovals.node")}
          description={hasNodes() ? undefined : t("devices.execApprovals.noNodes")}
          control={
            <select
              class="settings-select"
              aria-label={t("devices.execApprovals.node")}
              value={nodeValue()}
              disabled={props.disabled || !hasNodes()}
              onChange={(event) => {
                const target = event.currentTarget;
                const value = target.value.trim();
                props.onSelectTarget("node", value ? value : null);
                target.value = nodeValue();
              }}
            >
              <option value="" selected={nodeValue() === ""}>
                {t("devices.execApprovals.selectNode")}
              </option>
              <For each={props.targetNodes} keyed={(node) => node.id}>
                {(node) => (
                  <option value={node().id} selected={nodeValue() === node().id}>
                    {node().label}
                  </option>
                )}
              </For>
            </select>
          }
        />
      ) : undefined}
    </>
  );
}

function ExecApprovalsScope(props: ExecApprovalsState) {
  const options = createMemo(() => [
    {
      value: EXEC_APPROVALS_DEFAULT_SCOPE,
      label: t("devices.execApprovals.defaults"),
      // The unported selector owns rendering this opaque Lit icon.
      icon: legacyIcons.settings,
    },
    ...props.agents.map((agent) => ({
      value: agent.id,
      label: agent.name?.trim() ? `${agent.name} (${agent.id})` : agent.id,
      agent: { id: agent.id, ...(agent.name ? { name: agent.name } : {}) },
      badge: agent.isDefault ? t("agents.default") : undefined,
    })),
  ]);
  return (
    <SettingsRow
      title={t("devices.execApprovals.scope")}
      stacked={true}
      control={
        <openclaw-agent-select
          class="agent-select--settings"
          prop:options={options()}
          prop:value={props.selectedScope}
          prop:accessibleLabel={t("devices.execApprovals.scope")}
          prop:disabled={props.disabled}
          prop:onSelect={props.onSelectScope}
        />
      }
    />
  );
}

function ExecApprovalsPolicy(props: ExecApprovalsState) {
  const isDefaults = createMemo(() => props.selectedScope === EXEC_APPROVALS_DEFAULT_SCOPE);
  const defaults = createMemo(() => props.defaults);
  const agent = createMemo(() => props.selectedAgent ?? {});
  const basePath = createMemo(() =>
    isDefaults() ? ["defaults"] : ["agents", props.selectedScope],
  );
  const autoOverride = createMemo(() =>
    typeof agent().autoAllowSkills === "boolean" ? agent().autoAllowSkills : undefined,
  );
  const autoEffective = createMemo(() => autoOverride() ?? defaults().autoAllowSkills);
  const autoIsDefault = createMemo(() => autoOverride() == null);

  return (
    <>
      <For
        each={
          [
            {
              key: "security",
              descriptionKey: "devices.execApprovals.defaultSecurity",
              ariaLabelKey: "devices.execApprovals.mode",
              values: SECURITY_OPTIONS,
            },
            {
              key: "ask",
              descriptionKey: "devices.execApprovals.defaultPrompt",
              ariaLabelKey: "devices.execApprovals.mode",
              values: ASK_OPTIONS,
            },
            {
              key: "askFallback",
              descriptionKey: "devices.execApprovals.promptUnavailable",
              ariaLabelKey: "devices.execApprovals.fallback",
              values: SECURITY_OPTIONS,
            },
          ] as const
        }
      >
        {(field) => {
          const override = createMemo(() =>
            typeof agent()[field.key] === "string" ? agent()[field.key] : undefined,
          );
          const currentValue = () =>
            isDefaults() ? defaults()[field.key] : (override() ?? "__default__");
          return (
            <SettingsRow
              title={t(`devices.execApprovals.${field.key}`)}
              description={
                isDefaults()
                  ? t(field.descriptionKey)
                  : override() !== undefined
                    ? t("devices.execApprovals.defaultValue", { value: defaults()[field.key] })
                    : undefined
              }
              control={
                <select
                  class="settings-select"
                  aria-label={t(field.ariaLabelKey)}
                  value={currentValue()}
                  disabled={props.disabled}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    if (!isDefaults() && value === "__default__") {
                      props.onRemove([...basePath(), field.key]);
                    } else {
                      props.onPatch([...basePath(), field.key], value);
                    }
                  }}
                >
                  {!isDefaults() ? (
                    <option value="__default__" selected={currentValue() === "__default__"}>
                      {t("devices.execApprovals.useDefaultValue", {
                        value: defaults()[field.key],
                      })}
                    </option>
                  ) : undefined}
                  <For each={field.values}>
                    {(option) => (
                      <option value={option.value} selected={currentValue() === option.value}>
                        {t(option.labelKey)}
                      </option>
                    )}
                  </For>
                </select>
              }
            />
          );
        }}
      </For>
      <SettingsRow
        title={t("devices.execApprovals.autoAllowSkills")}
        description={
          isDefaults()
            ? t("devices.execApprovals.autoAllowSkillsHint")
            : autoIsDefault()
              ? undefined
              : t("devices.execApprovals.override", {
                  value: autoEffective()
                    ? t("devices.execApprovals.on")
                    : t("devices.execApprovals.off"),
                })
        }
        control={
          <>
            {!isDefaults() && !autoIsDefault() ? (
              <button
                class="btn btn--sm"
                disabled={props.disabled}
                onClick={() => props.onRemove([...basePath(), "autoAllowSkills"])}
              >
                {t("devices.execApprovals.useDefault")}
              </button>
            ) : undefined}
            <SettingsToggle
              checked={autoEffective()}
              disabled={props.disabled}
              ariaLabel={t("devices.execApprovals.autoAllowSkills")}
              onChange={(checked) => props.onPatch([...basePath(), "autoAllowSkills"], checked)}
            />
          </>
        }
      />
    </>
  );
}

function ExecApprovalsAllowlist(props: ExecApprovalsState) {
  const allowlistPath = createMemo(() => ["agents", props.selectedScope, "allowlist"]);
  const entries = createMemo(() => props.allowlist);
  return (
    <SettingsSection
      title={t("devices.execApprovals.allowlist")}
      description={t("devices.execApprovals.allowlistHint")}
      actions={
        <button
          class="btn btn--sm"
          disabled={props.disabled}
          onClick={() => props.onPatch(allowlistPath(), [...entries(), { pattern: "" }])}
        >
          {t("devices.execApprovals.addPattern")}
        </button>
      }
    >
      {entries().length === 0 ? (
        <SettingsEmpty message={t("devices.execApprovals.emptyAllowlist")} />
      ) : (
        <For each={entries()} keyed={false}>
          {(entry, index) => {
            const lastUsed = () =>
              entry().lastUsedAt ? formatRelativeTimestamp(entry().lastUsedAt) : t("common.never");
            const lastCommand = () =>
              entry().lastUsedCommand ? clampText(entry().lastUsedCommand ?? "", 120) : null;
            const lastPath = () =>
              entry().lastResolvedPath ? clampText(entry().lastResolvedPath ?? "", 120) : null;
            return (
              <SettingsRow
                title={
                  entry().pattern?.trim() ? entry().pattern : t("devices.execApprovals.newPattern")
                }
                description={
                  <>
                    {t("devices.execApprovals.lastUsed", { time: lastUsed() })}
                    {lastCommand() ? (
                      <>
                        <br />
                        <span class="mono">{lastCommand()}</span>
                      </>
                    ) : undefined}
                    {lastPath() ? (
                      <>
                        <br />
                        <span class="mono">{lastPath()}</span>
                      </>
                    ) : undefined}
                  </>
                }
                control={
                  <>
                    <input
                      class="settings-input"
                      type="text"
                      aria-label={t("devices.execApprovals.pattern")}
                      value={entry().pattern ?? ""}
                      disabled={props.disabled}
                      onInput={(event) => {
                        const target = event.currentTarget;
                        props.onPatch([...allowlistPath(), index, "pattern"], target.value);
                      }}
                    />
                    <button
                      class="btn btn--sm danger"
                      disabled={props.disabled}
                      onClick={() =>
                        props.onRemove(
                          props.allowlist.length <= 1
                            ? allowlistPath()
                            : [...allowlistPath(), index],
                        )
                      }
                    >
                      {t("devices.execApprovals.remove")}
                    </button>
                  </>
                }
              />
            );
          }}
        </For>
      )}
    </SettingsSection>
  );
}
