import type { PluginsListResult } from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { setPluginEnabled } from "../../lib/plugins/index.ts";

const SKILL_WORKSHOP_PLUGIN_ID = "skill-workshop";

/** Why the Gateway serves no Workshop methods, and whether the page can turn the plugin on. */
export type WorkshopPluginAvailability =
  | { status: "checking" }
  | { status: "off"; enabling: boolean; error: string | null }
  | { status: "missing" }
  | { status: "failed" }
  | { status: "error"; error: string };

/**
 * Reads the plugin's catalog entry for one connection and turns it on. Results for a retired
 * connection are dropped. Enabling publishes `plugins.changed`; the Gateway owner then refreshes
 * the method catalog and the page loads the Workshop like any other connection.
 */
export class WorkshopPluginAvailabilityOwner {
  state: WorkshopPluginAvailability | null = null;
  private client: GatewayBrowserClient | null = null;

  constructor(private readonly changed: () => void) {}

  /** `client` is the connection to explain, or null while the Workshop is served. */
  sync(client: GatewayBrowserClient | null): void {
    if (client === this.client) {
      return;
    }
    this.client = client;
    this.state = client ? { status: "checking" } : null;
    if (client) {
      void this.check(client);
    }
  }

  readonly retry = () => {
    if (this.client) {
      this.state = { status: "checking" };
      this.changed();
      void this.check(this.client);
    }
  };

  readonly enable = async () => {
    const client = this.client;
    if (!client || this.state?.status !== "off" || this.state.enabling) {
      return;
    }
    this.state = { status: "off", enabling: true, error: null };
    this.changed();
    try {
      await setPluginEnabled(client, SKILL_WORKSHOP_PLUGIN_ID, true);
    } catch (error) {
      if (this.client === client) {
        this.state = { status: "off", enabling: false, error: formatUiError(error) };
        this.changed();
      }
    }
  };

  private async check(client: GatewayBrowserClient): Promise<void> {
    let next: WorkshopPluginAvailability;
    try {
      const { plugins } = await client.request<PluginsListResult>("plugins.list", {});
      const entry = plugins.find((plugin) => plugin.id === SKILL_WORKSHOP_PLUGIN_ID);
      next = !entry
        ? { status: "missing" }
        : entry.enabled
          ? { status: "failed" }
          : { status: "off", enabling: false, error: null };
    } catch (error) {
      next = { status: "error", error: formatUiError(error) };
    }
    if (this.client === client) {
      this.state = next;
      this.changed();
    }
  }
}
