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
  omit,
  type Accessor,
} from "solid-js";
import { resolveNodeIdFromCandidates } from "../../../../src/shared/node-match.js";
import { SettingsRow, SettingsSection, SettingsPage } from "../../components/solid/settings-ui.tsx";
import { registerDevicesEnglish } from "../../i18n/locales/en-devices.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import "../../styles/devices.css";
import type { DevicePolicyRead } from "./devices-policy-reads.ts";
import { ExecApprovals, resolveExecApprovalsState } from "./view-exec-approvals.tsx";
import { DeviceInventory } from "./view-inventory-readiness.tsx";
import { resolveConfigAgents, resolveNodeTargets } from "./view-shared.tsx";
import type { DevicesProps } from "./view.types.ts";

registerEnglishCatalog(registerDevicesEnglish);

export function DevicesView(props: DevicesProps) {
  const bindingState = createMemo(() => resolveBindingsState(omit(props, "inventorySaving")));
  const approvalsState = createMemo(() =>
    resolveExecApprovalsState(omit(props, "inventorySaving")),
  );
  return (
    <SettingsPage wide={true}>
      <>
        {props.connected && (!props.canManagePairing || !props.canAdmin) ? (
          <div class="callout info" role="note">
            {t(
              !props.canManagePairing && !props.canAdmin
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
        <PolicyRead read={props.execApprovalsRead} onRetry={() => props.onLoadExecApprovals()}>
          {(pending) => (
            <ExecApprovals
              {...approvalsState()}
              loading={pending() || approvalsState().loading}
              disabled={pending() || approvalsState().disabled}
            />
          )}
        </PolicyRead>
        <PolicyRead read={props.configRead} onRetry={() => props.onLoadConfig()}>
          {(pending) => (
            <Bindings
              {...bindingState()}
              configLoading={pending() || props.configLoading}
              disabled={pending() || bindingState().disabled}
            />
          )}
        </PolicyRead>
      </>
    </SettingsPage>
  );
}

function PolicyRead(props: {
  read: DevicePolicyRead;
  onRetry: () => void;
  children: (pending: Accessor<boolean>) => JSX.Element;
}) {
  return (
    <Errored
      fallback={(error) => (
        <div class="callout danger" role="alert">
          {String(error())}
          <button class="btn" onClick={() => props.onRetry()}>
            {t("common.retry")}
          </button>
        </div>
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

function Bindings(props: BindingState) {
  const supportsBinding = () => props.nodes.length > 0;
  const saveButton = (
    <button
      class="btn"
      disabled={!props.connected || props.disabled || !props.configDirty}
      onClick={() => props.onSaveBindings()}
    >
      {props.configSaving ? t("common.saving") : t("common.save")}
    </button>
  );
  const rows = (
    <>
      {props.connected && !props.canAdmin ? (
        <SettingsRow title={t("devices.readOnly.adminRequired")} />
      ) : undefined}
      {props.configFormMode === "raw" ? (
        <SettingsRow title={t("devices.binding.formModeHint")} />
      ) : undefined}
      {!props.ready ? (
        <SettingsRow
          title={t("devices.binding.loadConfigHint")}
          control={
            <button
              class="btn"
              disabled={!props.connected || props.configLoading}
              onClick={() => props.onLoadConfig()}
            >
              {props.configLoading ? t("common.loading") : t("common.loadConfig")}
            </button>
          }
        />
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
    </>
  );
  return (
    <SettingsSection
      title={t("devices.binding.execNodeBinding")}
      description={t("devices.binding.execNodeBindingSubtitle")}
      actions={saveButton}
    >
      {rows}
    </SettingsSection>
  );
}

function AgentBinding(props: BindingState & { agent: BindingAgent }) {
  const bindingValue = () => props.agent.binding ?? "__default__";
  const label = () =>
    props.agent.name?.trim() ? `${props.agent.name} (${props.agent.id})` : props.agent.id;
  return (
    <SettingsRow
      title={label()}
      description={
        <>
          {props.agent.isDefault ? t("devices.binding.defaultAgent") : t("devices.binding.agent")} ·
          {bindingValue() === "__default__"
            ? t("devices.binding.usesDefault", {
                node: props.defaultBinding ?? t("devices.binding.any"),
              })
            : t("devices.binding.override", { node: props.agent.binding ?? "" })}
        </>
      }
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
    <select
      class="settings-select"
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
    >
      <option value={sentinel()} selected={selected() === sentinel()}>
        {t(isDefault() ? "devices.binding.anyNode" : "devices.binding.useDefault")}
      </option>
      <For each={options()} keyed={(node) => node.id}>
        {(node) => (
          <option value={node().id} selected={selected() === node().id} disabled={node().disabled}>
            {node().label}
          </option>
        )}
      </For>
    </select>
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
