import {
  GATEWAY_OWNER_PROFILE_ID,
  type UsersChannelIdentityParams,
  type UsersChannelIdentityResult,
} from "../../../../packages/gateway-protocol/src/schema/users.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { hasOperatorSelfReadAccess } from "../../app/operator-access.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { reserveExternalWindowForDeferredNavigation } from "../../lib/open-external-url.ts";

export class DiscordIdentityState {
  accounts: NonNullable<UsersChannelIdentityResult["accounts"]> = [];
  accountId = "";
  error: string | null = null;
  loading = false;
  busy = false;
  available = false;
  flow: { requestId: string; accountId: string; nonce: string; url: string } | null = null;
  private client: GatewayBrowserClient | null = null;
  private profileId: string | null = null;
  private connectionId: string | null = null;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(readonly publish: () => void) {}
  get selected() {
    return this.accounts.find((account) => account.accountId === this.accountId);
  }
  sync(snapshot: ApplicationGatewaySnapshot) {
    const profileId = snapshot.selfUser?.id ?? null;
    const connectionId = snapshot.hello?.server?.connId ?? null;
    const available =
      snapshot.phase === "connected" &&
      Boolean(profileId) &&
      profileId !== GATEWAY_OWNER_PROFILE_ID &&
      hasOperatorSelfReadAccess(snapshot.hello?.auth ?? null);
    if (
      this.client === snapshot.client &&
      this.profileId === profileId &&
      this.connectionId === connectionId &&
      this.available === available
    ) {
      return;
    }
    this.dispose();
    this.client = snapshot.client;
    this.profileId = profileId;
    this.connectionId = connectionId;
    this.available = available;
    this.accounts = [];
    this.accountId = "";
    this.error = null;
    this.busy = false;
    this.loading = false;
    if (available) {
      void this.load();
    }
    this.publish();
  }
  private clearFlow() {
    clearTimeout(this.timer);
    if (this.flow) {
      document.cookie =
        "openclaw-channel-link-" + this.flow.nonce + "=; Path=/; Max-Age=0; SameSite=Lax";
    }
    this.flow = null;
  }
  dispose() {
    this.generation++;
    const flow = this.flow;
    this.clearFlow();
    if (flow && this.client) {
      void this.client
        .request("users.channelIdentity", {
          action: "cancel",
          channelId: "discord",
          accountId: flow.accountId,
          requestId: flow.requestId,
        })
        .catch(() => {});
    }
    this.client = null;
    this.available = false;
  }
  private request(params: UsersChannelIdentityParams) {
    if (!this.client || !this.available) {
      throw new Error("Reconnect to manage your Discord identity.");
    }
    return this.client.request<UsersChannelIdentityResult>("users.channelIdentity", params);
  }
  async load() {
    const generation = this.generation;
    this.loading = true;
    this.publish();
    try {
      const result = await this.request({ action: "status", channelId: "discord" });
      if (generation !== this.generation) {
        return;
      }
      this.accounts = result.accounts ?? [];
      if (!this.selected) {
        this.accountId = this.accounts[0]?.accountId ?? "";
      }
      this.error = null;
    } catch (error) {
      if (generation === this.generation) {
        this.error = formatUiError(error);
      }
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.publish();
      }
    }
  }
  async connect() {
    if (this.busy || !this.selected?.available || this.flow) {
      return;
    }
    const generation = this.generation;
    const accountId = this.accountId;
    const nonce = crypto.randomUUID();
    const cookie = "openclaw-channel-link-" + nonce;
    // Written before leaving this authenticated browser. The OAuth callback requires it.
    document.cookie =
      cookie +
      "=" +
      nonce +
      "; Path=/; Max-Age=300; SameSite=Lax" +
      (location.protocol === "https:" ? "; Secure" : "");
    const popup = reserveExternalWindowForDeferredNavigation();
    this.busy = true;
    this.error = null;
    this.publish();
    try {
      const result = await this.request({
        action: "start",
        channelId: "discord",
        accountId,
        browserNonce: nonce,
      });
      if (generation !== this.generation) {
        popup?.close();
        return;
      }
      if (!result.requestId || !result.authorizationUrl) {
        throw new Error("Discord sign-in could not be started. Try again.");
      }
      this.flow = { requestId: result.requestId, accountId, nonce, url: result.authorizationUrl };
      if (popup) {
        popup.location.href = result.authorizationUrl;
      }
      this.timer = setTimeout(() => void this.poll(), 1500);
    } catch (error) {
      popup?.close();
      if (generation === this.generation) {
        this.error = formatUiError(error);
      }
    } finally {
      if (!this.flow || this.flow.nonce !== nonce) {
        document.cookie = cookie + "=; Path=/; Max-Age=0; SameSite=Lax";
      }
      if (generation === this.generation) {
        this.busy = false;
        this.publish();
      }
    }
  }
  private async poll() {
    const flow = this.flow;
    const generation = this.generation;
    if (!flow) {
      return;
    }
    try {
      const result = await this.request({
        action: "poll",
        channelId: "discord",
        accountId: flow.accountId,
        requestId: flow.requestId,
      });
      if (generation !== this.generation || this.flow !== flow) {
        return;
      }
      if (result.status === "pending") {
        this.timer = setTimeout(() => void this.poll(), 1500);
        return;
      }
      this.clearFlow();
      if (result.status === "linked") {
        await this.load();
      } else {
        this.error = result.message ?? "Discord sign-in was not completed. Try again.";
      }
    } catch (error) {
      if (generation === this.generation && this.flow === flow) {
        this.clearFlow();
        this.error = formatUiError(error);
      }
    }
    if (generation === this.generation) {
      this.publish();
    }
  }
  async mutate(action: "disconnect" | "cancel") {
    if (this.busy) {
      return;
    }
    const generation = this.generation;
    const flow = this.flow;
    this.busy = true;
    this.error = null;
    this.publish();
    try {
      if (action === "cancel" && flow) {
        await this.request({
          action,
          channelId: "discord",
          accountId: flow.accountId,
          requestId: flow.requestId,
        });
      } else if (action === "disconnect") {
        await this.request({ action, channelId: "discord", accountId: this.accountId });
      }
      if (generation !== this.generation) {
        return;
      }
      this.clearFlow();
      await this.load();
    } catch (error) {
      if (generation === this.generation) {
        this.error = formatUiError(error);
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.publish();
      }
    }
  }
}
