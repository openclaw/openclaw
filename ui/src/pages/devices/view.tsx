import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import type { JSX } from "@solidjs/web";
import {
  createMemo,
  Errored,
  For,
  isPending,
  latest,
  Loading,
  Show,
  omit,
  type Accessor,
} from "solid-js";
import { resolveNodeIdFromCandidates } from "../../../../src/shared/node-match.js";
import { SettingsSelect } from "../../components/solid/settings-select.tsx";
import {
  SettingsEmpty,
  SettingsRow,
  SettingsSection,
  SettingsPage,
  SettingsLoadingSkeleton,
} from "../../components/solid/settings-ui.tsx";
import { registerDevicesEnglish } from "../../i18n/locales/en-devices.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import "../../styles/devices.css";
import type { DevicePolicyRead } from "./devices-policy-reads.ts";
import { ExecApprovals, resolveExecApprovalsState } from "./view-exec-approvals.tsx";
import { DeviceInventory } from "./view-inventory-readiness.tsx";
import {
  agentDisplayName,
  PolicyActionRow,
  PolicyFailure,
  resolveConfigAgents,
  resolveNodeTargets,
} from "./view-shared.tsx";
import type { DevicesProps } from "./view.types.ts";

registerEnglishCatalog(registerDevicesEnglish);

export function DevicesView(props: DevicesProps) {
  const bindingState = createMemo(() => resolveBindingsState(omit(props, "inventorySaving")));
  const approvalsState = createMemo(() =>
    resolveExecApprovalsState(omit(props, "inventorySaving")),
  );
  return (
    <SettingsPage wide={true}>
      {/* Inventory belongs above policy; wait for its first snapshot before painting either. */}
      <Show when={props.initialInventoryReady} fallback={<SettingsLoadingSkeleton />}>
        {props.connected && (!props.canManagePairing || !props.canAdmin) ? (
          <div class="callout info" role="note">
            {t(
              props.roleAllowsAdmin === true
                ? "devices.readOnly.browserPairingRequired"
                : !props.canManagePairing && !props.canAdmin
                  ? "devices.readOnly.pairingAndAdminRequired"
                  : !props.canManagePairing
                    ? "devices.readOnly.pairingRequired"
                    : "devices.readOnly.adminRequired",
            )}
          </div>
        ) : undefined}
        {props.devicesError ? (
          <div class="callout danger" role="alert">
            {props.devicesError}
          </div>
        ) : undefined}
        {props.lastError ? (
          <div class="callout danger" role="alert">
            {props.lastError}
          </div>
        ) : undefined}
        <DeviceInventory {...props} />
        <PolicyRead
          read={props.execApprovalsRead}
          title={t("devices.execApprovals.title")}
          failure={t("devices.execApprovals.loadFailed")}
          onRetry={() => props.onLoadExecApprovals()}
        >
          {(pending) => (
            <ExecApprovals
              {...approvalsState()}
              loading={pending() || approvalsState().loading}
              disabled={pending() || approvalsState().disabled}
            />
          )}
        </PolicyRead>
        <PolicyRead
          read={props.configRead}
          title={t("devices.binding.execNodeBinding")}
          failure={t("devices.binding.loadFailed")}
          onRetry={() => props.onLoadConfig()}
        >
          {(pending) => (
            <Bindings
              {...bindingState()}
              configLoading={pending() || props.configLoading}
              disabled={pending() || bindingState().disabled}
            />
          )}
        </PolicyRead>
      </Show>
    </SettingsPage>
  );
}

function PolicyRead(props: {
  read: DevicePolicyRead;
  title: string;
  failure: string;
  onRetry: () => void;
  children: (pending: Accessor<boolean>) => JSX.Element;
}) {
  return (
    <Errored
      fallback={(error) => (
        <SettingsSection title={props.title}>
          <PolicyFailure
            title={props.failure}
            message={formatUiError(error())}
            onRetry={props.onRetry}
          />
        </SettingsSection>
      )}
    >
      <Loading on={props.read.scope()} fallback={props.children(() => true)}>
        {(latest(props.read.value), null)}
        {props.children(() => isPending(props.read.value))}
      </Loading>
    </Errored>
  );
}

type BindingAgent = BindingState["agents"][number];
type BindingState = ReturnType<typeof resolveBindingsState>;

function resolveBindingsState(input: DevicesProps) {
  return {
    ...input,
    ...resolveAgentBindings(input.configForm),
    ready: Boolean(input.configForm),
    disabled:
      !input.canAdmin ||
      input.configLoading ||
      input.configSaving ||
      input.configFormMode === "raw",
    nodes: resolveNodeTargets(input.nodes, ["system.run"]),
    inventory: input.nodes,
  };
}

/** Bindings autosave like the rest of config; the settings save indicator reports them. */
function Bindings(props: BindingState) {
  const supportsBinding = () => props.nodes.length > 0;
  const hasBinding = () =>
    props.defaultBinding !== null || props.agents.some((agent) => agent.binding !== null);
  return (
    <SettingsSection
      title={t("devices.binding.execNodeBinding")}
      description={t("devices.binding.execNodeBindingSubtitle")}
    >
      {props.configFormMode === "raw" ? (
        <PolicyActionRow description={t("devices.binding.formModeHint")} />
      ) : undefined}
      {!props.ready ? (
        props.configLoading ? (
          <PolicyActionRow description={t("common.loading")} />
        ) : (
          <PolicyActionRow description={t("devices.binding.loadConfigHint")}>
            <button class="btn" disabled={!props.connected} onClick={() => props.onLoadConfig()}>
              {t("common.loadConfig")}
            </button>
          </PolicyActionRow>
        )
      ) : !supportsBinding() && !hasBinding() ? (
        <SettingsEmpty message={t("devices.binding.noNodes")} />
      ) : (
        <>
          <SettingsRow
            title={t("devices.binding.defaultBinding")}
            description={
              supportsBinding() ? (
                t("devices.binding.defaultBindingHint")
              ) : (
                <>
                  {t("devices.binding.defaultBindingHint")} {t("devices.binding.noNodes")}
                </>
              )
            }
            control={<BindingSelect {...props} agent={null} />}
          />
          <For each={props.agents} keyed={(agent) => agent.id}>
            {(agent) => <AgentBinding {...props} agent={agent()} />}
          </For>
        </>
      )}
    </SettingsSection>
  );
}

function AgentBinding(props: BindingState & { agent: BindingAgent }) {
  return (
    <SettingsRow
      title={agentDisplayName(props.agent)}
      description={props.agent.isDefault ? t("devices.binding.defaultAgent") : undefined}
      control={<BindingSelect {...props} agent={props.agent} />}
    />
  );
}

function BindingSelect(props: BindingState & { agent: BindingAgent | null }) {
  const isDefault = () => props.agent === null;
  const sentinel = () => (isDefault() ? "" : "__default__");
  const selected = () =>
    isDefault() ? (props.defaultBinding ?? "") : (props.agent?.binding ?? "__default__");
  const options = createMemo(() => {
    const value = selected();
    let resolvedId: string | undefined;
    if (value !== sentinel()) {
      try {
        // Resolve the complete inventory before capability filtering, just like exec.
        resolvedId = resolveNodeIdFromCandidates(props.inventory, value);
      } catch {
        // Unknown and ambiguous references stay visible without changing configuration.
      }
    }
    const result = props.nodes.map((node) => ({
      ...node,
      id: node.id === resolvedId ? value : node.id,
      disabled: false,
    }));
    if (value !== sentinel() && !result.some((node) => node.id === value)) {
      result.push({
        id: value,
        label: `${value} (${t("devices.binding.unavailable")})`,
        disabled: true,
      });
    }
    return result;
  });

  return (
    <SettingsSelect
      aria-label={t(isDefault() ? "devices.binding.node" : "devices.binding.binding")}
      value={selected()}
      disabled={props.disabled || (props.nodes.length === 0 && selected() === sentinel())}
      onChange={(event) => {
        const value = event.currentTarget.value.trim();
        if (props.agent === null) {
          props.onBindDefault(value || null);
        } else {
          props.onBindAgent(props.agent.id, value === "__default__" ? null : value);
        }
      }}
      options={[
        {
          value: sentinel(),
          label: isDefault()
            ? t("devices.binding.anyNode")
            : t("devices.binding.useDefaultValue", {
                node: props.defaultBinding ?? t("devices.binding.anyNode"),
              }),
        },
        ...options().map((node) => ({
          value: node.id,
          label: node.label,
          disabled: node.disabled,
        })),
      ]}
    />
  );
}

function resolveAgentBindings(config: Record<string, unknown> | null) {
  const fallbackAgent = {
    id: "main",
    name: undefined,
    isDefault: true,
    binding: null,
  };
  if (!config) {
    return { defaultBinding: null, agents: [fallbackAgent] };
  }
  const tools = isRecord(config.tools) ? config.tools : {};
  const exec = isRecord(tools.exec) ? tools.exec : {};
  const defaultBinding = normalizeNullableString(exec.node);

  const agents = resolveConfigAgents(config).map((entry) => {
    const toolsEntry = isRecord(entry.record.tools) ? entry.record.tools : {};
    const execEntry = isRecord(toolsEntry.exec) ? toolsEntry.exec : {};
    return {
      id: entry.id,
      name: entry.name,
      isDefault: entry.isDefault,
      binding: normalizeNullableString(execEntry.node),
    };
  });

  return { defaultBinding, agents: agents.length === 0 ? [fallbackAgent] : agents };
}
