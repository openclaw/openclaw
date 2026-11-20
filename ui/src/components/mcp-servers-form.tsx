import { createSignal, Show } from "solid-js";
import { registerMcpEnglish } from "../i18n/locales/en-mcp.ts";
import type { McpServerTransport } from "../lib/config/mcp-servers.ts";
import { t } from "../lib/reactive/i18n.ts";
import type { McpServerForm } from "./mcp-server-form.ts";
import { SettingsSegmented } from "./solid/settings-ui.tsx";
import "../styles/mcp-server-form.css";

registerMcpEnglish();

export function McpServersForm(props: {
  busy: boolean;
  disabled: boolean;
  blockedReason: string | null;
  autofocus?: boolean;
  onNameRef?: (element: HTMLInputElement) => void;
  error?: string | null;
  onSubmit: (form: McpServerForm) => void;
  onCancel: () => void;
}) {
  const disabled = () => props.busy || props.disabled;
  const [transport, setTransport] = createSignal<McpServerTransport>("streamable-http");
  return (
    <form
      class="mcp-server-form"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const name = data.get("mcp-name");
        const target = data.get("mcp-target");
        props.onSubmit({
          name: typeof name === "string" ? name.trim() : "",
          transport: transport(),
          target: typeof target === "string" ? target.trim() : "",
        });
      }}
    >
      <label>
        <span>{t("mcpServers.nameLabel")}</span>
        <input
          ref={props.onNameRef}
          name="mcp-name"
          autofocus={props.autofocus}
          class="settings-input"
          type="text"
          required
          placeholder="context7"
          autocomplete="off"
          title={props.blockedReason ?? ""}
          disabled={disabled()}
        />
      </label>
      <div class="mcp-server-form__field">
        <span>{t("mcpServers.transportLabel")}</span>
        <SettingsSegmented<McpServerTransport>
          value={transport()}
          ariaLabel={t("mcpServers.transportLabel")}
          disabled={disabled()}
          options={[
            { value: "streamable-http", label: t("mcpServers.transportStreamableHttp") },
            { value: "sse", label: t("mcpServers.transportSse") },
            { value: "stdio", label: t("mcpServers.transportStdio") },
          ]}
          onChange={setTransport}
        />
      </div>
      <label>
        <span>{t("mcpServers.targetLabel")}</span>
        <input
          name="mcp-target"
          class="settings-input"
          type="text"
          required
          spellcheck="false"
          placeholder={
            transport() === "stdio" ? "npx some-mcp-server" : "https://mcp.example.com/mcp"
          }
          autocomplete="off"
          title={props.blockedReason ?? ""}
          disabled={disabled()}
        />
      </label>
      <Show when={props.error}>
        {(error) => (
          <div class="mcp-server-message mcp-server-message--error" role="alert">
            {error()}
          </div>
        )}
      </Show>
      <openclaw-modal-actions class="mcp-server-form__actions">
        <button
          type="button"
          class="btn btn--sm"
          disabled={props.busy}
          onClick={() => props.onCancel()}
        >
          {t("common.cancel")}
        </button>
        <button
          type="submit"
          class="btn btn--sm primary"
          title={props.blockedReason ?? ""}
          disabled={disabled()}
        >
          {props.busy ? t("mcpServers.adding") : t("mcpServers.add")}
        </button>
      </openclaw-modal-actions>
    </form>
  );
}
