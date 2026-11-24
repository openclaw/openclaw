import type { PluginsListResult } from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { setPluginEnabled } from "../../lib/plugins/index.ts";

const SKILL_WORKSHOP_PLUGIN_ID = "skill-workshop";

/** Why the Gateway serves no Workshop methods, and whether the page can turn the plugin on. */
export type WorkshopPluginAvailability =
  | { status: "checking" }
  | { status: "off"; enabling: boolean; error: unknown }
  | { status: "missing" }
  | { status: "failed" }
  // Turned on, but this connection never learned the Workshop methods.
  | { status: "reload" }
  | { status: "error"; error: unknown };

/** How long a successful enable may wait for the Gateway to publish the Workshop. */
const WORKSHOP_PUBLISH_TIMEOUT_MS = 15_000;

/**
 * Reads the plugin's catalog entry for one connection and turns it on. Results for a retired
 * connection are dropped. Enabling publishes `plugins.changed`; the Gateway owner then refreshes
 * the method catalog and the page loads the Workshop like any other connection.
 */
export class WorkshopPluginAvailabilityOwner {
  state: WorkshopPluginAvailability | null = null;
  private client: GatewayBrowserClient | null = null;
  private publishTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly changed: () => void) {}

  /** `client` is the connection to explain, or null while the Workshop is served. */
  sync(client: GatewayBrowserClient | null): void {
    if (client === this.client) {
      return;
    }
    clearTimeout(this.publishTimer);
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
        this.state = { status: "off", enabling: false, error };
        this.changed();
      }
      return;
    }
    // `plugins.changed` normally loads the Workshop in place; that broadcast may be dropped
    // for a slow client, so recheck instead of leaving the button busy.
    if (this.client === client) {
      this.publishTimer = setTimeout(
        () => void this.check(client, true),
        WORKSHOP_PUBLISH_TIMEOUT_MS,
      );
    }
  };

  dispose(): void {
    clearTimeout(this.publishTimer);
    this.client = null;
  }

  private async check(client: GatewayBrowserClient, afterEnable = false): Promise<void> {
    let next: WorkshopPluginAvailability;
    try {
      const { plugins } = await client.request<PluginsListResult>("plugins.list", {});
      const entry = plugins.find((plugin) => plugin.id === SKILL_WORKSHOP_PLUGIN_ID);
      next = !entry
        ? { status: "missing" }
        : entry.enabled
          ? { status: afterEnable ? "reload" : "failed" }
          : { status: "off", enabling: false, error: null };
    } catch (error) {
      next = { status: "error", error };
    }
    if (this.client === client) {
      this.state = next;
      this.changed();
    }
  }
}
