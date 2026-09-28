// Throwaway prototype: one shared alert, live HTTP and plugin-owned stdio detectors.
import { html, nothing, render, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { icons } from "../../components/icons.ts";
import "../../components/modal-dialog.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import "./auth-detail-prototype.css";

type Observation = {
  state: "needs-auth" | "needs-permission" | "connected" | "unavailable" | "unsupported";
  detector?: string;
  transport?: string;
  checkedAt?: string;
  initialized?: boolean;
  toolCount?: number;
  httpStatus?: number;
};
class AuthDetailPrototype extends OpenClawLightDomElement {
  @property() pluginId = "";
  @state() private observation: Observation | null = null;
  @state() private checking = true;
  @state() private connecting = false;
  @state() private panel: "evidence" | "setup" | null = null;
  @state() private notice = "";
  private request?: AbortController;
  private loginRequest?: AbortController;
  private controls = document.createElement("div");
  private baseline = new URLSearchParams(location.search).has("baseline");
  private get supported() {
    return this.pluginId === "notion" || this.pluginId === "notion-local";
  }
  private get local() {
    return this.pluginId === "notion-local";
  }
  override connectedCallback() {
    super.connectedCallback();
    document.body.append(this.controls);
  }
  override disconnectedCallback() {
    this.request?.abort();
    this.loginRequest?.abort();
    this.controls.remove();
    super.disconnectedCallback();
  }
  protected override willUpdate(changed: PropertyValues) {
    if (changed.has("pluginId")) {
      this.request?.abort();
      this.loginRequest?.abort();
      this.connecting = false;
      this.observation = null;
      this.panel = null;
      this.notice = "";
      if (this.supported && !this.baseline) {
        void this.probe();
      }
    }
  }
  private async probe() {
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    this.checking = true;
    try {
      const response = await fetch(`/__auth-detail/probe?plugin=${this.pluginId}`, {
        method: "POST",
        signal: request.signal,
      });
      const observation = (await response.json()) as Observation;
      if (!request.signal.aborted) {
        this.observation = observation;
      }
    } catch {
      if (!request.signal.aborted) {
        this.observation = { state: "unavailable" };
      }
    } finally {
      if (!request.signal.aborted) {
        this.checking = false;
      }
    }
  }
  private async connect() {
    if (this.local) {
      this.panel = "setup";
      return;
    }
    const request = new AbortController();
    this.loginRequest = request;
    this.connecting = true;
    this.notice = "";
    try {
      const response = await fetch("/__auth-detail/start", {
        method: "POST",
        signal: request.signal,
      });
      const result = (await response.json()) as { url?: string };
      if (!response.ok || !result.url) {
        throw new Error("No authorization URL");
      }
      if (!request.signal.aborted && this.isConnected) {
        location.assign(result.url);
      }
    } catch {
      if (!request.signal.aborted) {
        this.notice = "Couldn’t open Notion sign-in. Try again.";
        this.connecting = false;
      }
    }
  }
  private banner() {
    if (this.checking && !this.observation) {
      return html`<div class="auth-detail-loading" role="status">
        ${icons.loader} Checking Notion connection…
      </div>`;
    }
    const status = this.observation?.state;
    if (status === "connected" || status === "unsupported") {
      return nothing;
    }
    const auth = status === "needs-auth" || status === "needs-permission";
    const title = !auth
      ? "Couldn’t check the connection"
      : status === "needs-permission"
        ? "Notion needs additional permissions"
        : this.local
          ? "Notion token required"
          : "Sign in to Notion";
    return html`<section
      class="auth-detail-alert ${auth ? "" : "auth-detail-alert--unavailable"}"
      aria-label="Plugin connection"
      data-auth-state=${status}
    >
      <span class="auth-detail-icon" aria-hidden="true"
        >${auth ? icons.key : icons.alertTriangle}</span
      >
      <div class="auth-detail-copy">
        <h2>${title}</h2>
      </div>
      <button
        class="btn oc-action oc-action-secondary auth-detail-action"
        ?disabled=${this.connecting || this.checking}
        @click=${() => (auth ? this.connect() : this.probe())}
      >
        ${!auth ? "Try again" : this.connecting ? "Opening Notion…" : this.local ? "Set up token" : status === "needs-permission" ? "Review permissions" : "Connect"}${auth && !this.local ? icons.arrowUpRight : nothing}
      </button>
    </section>`;
  }
  protected override updated() {
    render(
      this.baseline || !this.supported
        ? nothing
        : html`<aside class="auth-detail-controls" aria-label="Prototype controls">
            <span><strong>PROTOTYPE</strong> <span>main · 018639af</span></span>
            <nav aria-label="Live examples">
              <a href="/settings/plugins/notion" aria-current=${this.local ? nothing : "page"}
                >HTTP plugin</a
              ><a
                href="/settings/plugins/notion-local"
                aria-current=${this.local ? "page" : nothing}
                >Local stdio</a
              >
            </nav>
            <button @click=${() => (this.panel = "evidence")}>
              Live evidence ${icons.arrowUpRight}
            </button>
          </aside>`,
      this.controls,
    );
  }
  override render() {
    if (this.baseline || !this.supported) {
      return nothing;
    }
    return html`${this.banner()}${this.notice ? html`<p class="auth-detail-notice" role="status">${this.notice}</p>` : nothing}
    ${
      this.panel
        ? html`<openclaw-modal-dialog
            .label=${this.panel === "evidence" ? "Live connection evidence" : "Set up Notion locally"}
            @modal-cancel=${() => (this.panel = null)}
          >
            <div class="auth-detail-dialog">
              <div class="auth-detail-dialog-heading">
                <h2>
                  ${this.panel === "evidence" ? "Live connection evidence" : "Set up Notion locally"}
                </h2>
                <button class="btn" aria-label="Close dialog" @click=${() => (this.panel = null)}>
                  ${icons.x}
                </button>
              </div>
              ${
                this.panel === "evidence"
                  ? html`
                      <span class="auth-detail-tag"
                        >LIVE CHECK · ${this.observation?.transport ?? "Connecting"}</span
                      >
                      <p>
                        ${this.local ? "This detector starts the official local server, then calls a read-only Notion account tool to check access." : "This detector checks the hosted server used by Notion’s official plugin. Its observed response appears below."}
                      </p>
                      <div class="auth-detail-flow">
                        <span
                          >${this.local ? (this.observation?.initialized ? `MCP started · ${this.observation.toolCount} tools` : "MCP startup not confirmed") : `MCP request · HTTP ${this.observation?.httpStatus ?? "—"}`}</span
                        ><span aria-hidden="true">→</span
                        ><span>${this.local ? "Notion account check" : "HTTP auth detector"}</span
                        ><span aria-hidden="true">→</span
                        ><strong
                          >${this.checking ? "Checking…" : this.observation ? { "needs-auth": "Needs authentication", "needs-permission": "Needs permissions", connected: "Connected", unavailable: "Check unsuccessful", unsupported: "Check unavailable" }[this.observation.state] : "Not checked"}</strong
                        >
                      </div>
                      <pre>${JSON.stringify(this.observation, null, 2)}</pre>
                      <p class="auth-detail-disclosure">
                        The app inventory is an isolated fixture. The server, request, and response
                        are real. No sign-in success is simulated.
                      </p>
                      <button
                        class="btn"
                        @click=${() => navigator.clipboard.writeText(JSON.stringify(this.observation, null, 2))}
                      >
                        Copy observed state
                      </button>
                    `
                  : html`
                      <p>This server uses a Notion integration token instead of browser sign-in.</p>
                      <ol>
                        <li>
                          Create a Notion integration and grant it access to the pages you want to
                          use.
                        </li>
                        <li>
                          Add its token as <code>NOTION_TOKEN</code> in the local server’s
                          environment.
                        </li>
                        <li>Restart the server and check the connection again.</li>
                      </ol>
                      <pre>"env": { "NOTION_TOKEN": "&lt;your integration token&gt;" }</pre>
                      <p class="auth-detail-disclosure">
                        This demo launches an isolated process without credentials. It does not read
                        or change your saved configuration. Notion no longer actively maintains this
                        local server; use the hosted plugin for new connections.
                      </p>
                      <a
                        class="btn oc-action oc-action-secondary"
                        href="https://www.notion.so/profile/integrations"
                        target="_blank"
                        rel="noreferrer"
                        >Open integration settings ${icons.arrowUpRight}</a
                      >
                    `
              }
            </div></openclaw-modal-dialog
          >`
        : nothing
    }`;
  }
}
customElements.define("openclaw-auth-detail-prototype", AuthDetailPrototype);
