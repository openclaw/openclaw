import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import { createMemo, createSignal, Show } from "solid-js";
import { ConfigNode } from "../../components/config-form.node.tsx";
import { ConfigTierGroups } from "../../components/config-form.render.tsx";
import type { JsonSchema } from "../../components/config-form.shared.ts";
import { SettingsRow, SettingsSegmented } from "../../components/solid/settings-ui.tsx";
import { containsRedactedSentinel } from "../../lib/config-form-utils.ts";
import { MCP_SERVER_NAME_PATTERN, type McpServerSummary } from "../../lib/config/mcp-servers.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { liveValue } from "../../lib/reactive/live-value.ts";
import { mcpServerFieldNames, mcpServerHints, mcpServerSchema } from "./mcp-schema.ts";
import { isSensitivePathRevealed, toggleSensitivePathReveal } from "./view-state.ts";
import type { ConfigProps } from "./view-types.ts";

const SERVERS_PATH = ["mcp", "servers"];

/** Applies an edit of the one-argument-per-line text. Only arguments on lines the edit
    touched change; every other argument is kept as saved, spaces and empty ones included. */
function editArgs(saved: readonly unknown[], text: string): unknown[] {
  const spans = saved.map((arg) => String(arg).split("\n").length);
  const before = saved.join("\n").split("\n");
  const after = text.split("\n");
  const max = Math.min(before.length, after.length);
  let head = 0;
  while (head < max && before[head] === after[head]) {
    head++;
  }
  let tail = 0;
  while (tail < max - head && before.at(-1 - tail) === after.at(-1 - tail)) {
    tail++;
  }
  // Whole arguments outside the touched lines; one that spans them counts as touched.
  let headArgs = 0;
  let headLines = 0;
  for (const span of spans) {
    if (headLines + span > head) {
      break;
    }
    headLines += span;
    headArgs++;
  }
  let tailArgs = 0;
  let tailLines = 0;
  for (const span of spans.slice(headArgs).toReversed()) {
    if (tailLines + span > tail) {
      break;
    }
    tailLines += span;
    tailArgs++;
  }
  const touched = after
    .slice(headLines, after.length - tailLines)
    .map((line) => line.trim())
    .filter(Boolean);
  return [...saved.slice(0, headArgs), ...touched, ...saved.slice(saved.length - tailArgs)];
}

/** One server's saved fields, using the same autosave and redaction as every config form. */
export function McpServerEditor(props: {
  config: ConfigProps;
  server: McpServerSummary;
  onRenamed: (name: string) => void;
}) {
  const [revision, setRevision] = createSignal(0);
  const path = () => [...SERVERS_PATH, props.server.name];
  const servers = () => asConfigRecord(asConfigRecord(props.config.formValue?.mcp)?.servers) ?? {};
  const value = () => asConfigRecord(servers()[props.server.name]);
  const stdio = () => props.server.transport === "stdio";
  // The form shows `auth` as a switch; the patch below writes the literal back.
  const fieldValues = () => {
    const current = value();
    return current ? { ...current, auth: current.auth === "oauth" } : undefined;
  };
  // Each tier only receives its own named fields, so another tier's never read as custom entries.
  const fieldsOutside = (tier: JsonSchema) =>
    mcpServerFieldNames(props.config.schema).filter((key) => !(key in (tier.properties ?? {})));
  const tierValues = (tier: JsonSchema) => {
    const current = fieldValues();
    const outside = fieldsOutside(tier);
    return (
      current &&
      Object.fromEntries(Object.entries(current).filter(([key]) => !outside.includes(key)))
    );
  };
  // A custom entry patches the whole tier value; what the tier never saw goes back in.
  const withFieldsOutside = (tier: JsonSchema, next: unknown) => {
    const current = value() ?? {};
    const outside = fieldsOutside(tier).filter((key) => Object.hasOwn(current, key));
    return { ...asConfigRecord(next), ...Object.fromEntries(outside.map((k) => [k, current[k]])) };
  };
  const hints = createMemo(() => mcpServerHints(props.config.uiHints));
  const schema = createMemo(() => mcpServerSchema(props.config.schema, value(), stdio()));
  const disabled = () =>
    props.config.loading ||
    props.config.saving ||
    props.config.applying ||
    props.config.updating ||
    props.config.schemaLoading ||
    !props.config.formValue ||
    props.config.mutationAllowed === false;
  const [renameError, setRenameError] = createSignal("");
  const nameValue = liveValue<HTMLInputElement>(() => props.server.name);
  const commandText = () => {
    const command = value()?.command;
    return typeof command === "string" ? command : "";
  };
  const commandValue = liveValue<HTMLInputElement>(commandText);
  // One argument per line keeps long paths readable and needs no shell quoting.
  const argsValue = liveValue<HTMLTextAreaElement>(() => {
    const args = value()?.args;
    return Array.isArray(args) ? args.join("\n") : "";
  });
  const rename = (input: HTMLInputElement) => {
    setRenameError("");
    const name = props.server.name;
    const next = input.value.trim();
    if (next === name) {
      input.value = name;
      return;
    }
    // A new key must never carry a server-redacted credential sentinel.
    const reason = Object.hasOwn(servers(), next)
      ? t("mcpServers.nameTaken", { name: next })
      : !MCP_SERVER_NAME_PATTERN.test(next)
        ? t("mcpServers.nameInvalid")
        : containsRedactedSentinel(servers()[name])
          ? t("configForm.renameRedactedBlocked")
          : "";
    if (reason) {
      input.value = name;
      setRenameError(reason);
      return;
    }
    const { [name]: renamed, ...others } = servers();
    props.config.onFormPatch(SERVERS_PATH, { ...others, [next]: renamed });
    props.onRenamed(next);
  };
  return (
    <Show when={schema()}>
      {(fields) => (
        <div class="mcp-server-editor">
          <ConfigTierGroups
            schema={fields()}
            path={path()}
            hints={hints()}
            revealAdvanced={
              props.config.forceShowAdvanced === true || props.config.showAdvancedSettings
            }
            onShowAdvanced={() => props.config.onAppearanceChange({ showAdvancedSettings: true })}
            onHideAdvanced={() => props.config.onAppearanceChange({ showAdvancedSettings: false })}
            commonPrelude={
              <>
                <SettingsRow
                  title={t("mcpServers.nameLabel")}
                  description={
                    <Show when={renameError()}>
                      <span class="cfg-field__error" role="alert">
                        {renameError()}
                      </span>
                    </Show>
                  }
                  control={
                    <input
                      type="text"
                      class="settings-input"
                      aria-label={t("mcpServers.nameLabel")}
                      spellcheck="false"
                      autocomplete="off"
                      ref={nameValue}
                      disabled={disabled()}
                      onInput={() => setRenameError("")}
                      onChange={(event) => rename(event.currentTarget)}
                    />
                  }
                />
                <Show when={stdio()}>
                  <SettingsRow
                    title={t("mcpServers.fieldCommand")}
                    control={
                      <input
                        type="text"
                        class="settings-input"
                        aria-label={t("mcpServers.fieldCommand")}
                        spellcheck="false"
                        autocomplete="off"
                        ref={commandValue}
                        disabled={disabled()}
                        onChange={(event) => {
                          const command = event.currentTarget.value.trim();
                          if (command) {
                            props.config.onFormPatch([...path(), "command"], command);
                          } else {
                            // A stdio server needs a command; restore instead of saving invalid config.
                            event.currentTarget.value = commandText();
                          }
                        }}
                      />
                    }
                  />
                  <SettingsRow
                    stacked
                    title={t("mcpServers.fieldArgs")}
                    description={t("mcpServers.fieldArgsHint")}
                    control={
                      <textarea
                        class="settings-input"
                        aria-label={t("mcpServers.fieldArgs")}
                        spellcheck="false"
                        autocomplete="off"
                        ref={argsValue}
                        disabled={disabled()}
                        onChange={(event) => {
                          const saved = value()?.args;
                          const args = editArgs(
                            Array.isArray(saved) ? saved : [],
                            event.currentTarget.value,
                          );
                          if (args.length > 0) {
                            props.config.onFormPatch([...path(), "args"], args);
                          } else {
                            props.config.onFormRemove([...path(), "args"]);
                          }
                        }}
                      />
                    }
                  />
                </Show>
                <Show when={!stdio()}>
                  <SettingsRow
                    title={t("mcpServers.transportLabel")}
                    control={
                      <SettingsSegmented<"streamable-http" | "sse">
                        value={value()?.transport === "streamable-http" ? "streamable-http" : "sse"}
                        ariaLabel={t("mcpServers.transportLabel")}
                        disabled={disabled()}
                        options={[
                          {
                            value: "streamable-http",
                            label: t("mcpServers.transportStreamableHttp"),
                          },
                          { value: "sse", label: t("mcpServers.transportSse") },
                        ]}
                        onChange={(transport) =>
                          props.config.onFormPatch([...path(), "transport"], transport)
                        }
                      />
                    }
                  />
                </Show>
              </>
            }
            renderTier={(node) => (
              <ConfigNode
                params={{
                  schema: node(),
                  value: tierValues(node()),
                  path: path(),
                  hints: hints(),
                  rawAvailable: props.config.rawAvailable ?? true,
                  unsupported: new Set(),
                  disabled: disabled(),
                  showLabel: false,
                  showHeaderMeta: true,
                  maskSensitive: true,
                  isSensitivePathRevealed: (target) => {
                    revision();
                    return isSensitivePathRevealed(props.config.viewState, target);
                  },
                  onToggleSensitivePath: (target) => {
                    toggleSensitivePathReveal(props.config.viewState, target);
                    setRevision((current) => current + 1);
                    props.config.onViewStateChange();
                  },
                  onPatch: (target, next) =>
                    target.length === path().length
                      ? props.config.onFormPatch(target, withFieldsOutside(node(), next))
                      : target.at(-1) === "auth" && target.length === path().length + 1
                        ? next === true
                          ? props.config.onFormPatch(target, "oauth")
                          : props.config.onFormRemove(target)
                        : props.config.onFormPatch(target, next),
                  onRemove: props.config.onFormRemove,
                }}
              />
            )}
          />
        </div>
      )}
    </Show>
  );
}
